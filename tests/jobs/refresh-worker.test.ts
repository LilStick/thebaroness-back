import { Types } from 'mongoose';
import type { Logger } from 'pino';
import { createServices } from '../../src/app';
import { ApiCacheModel } from '../../src/database/api-cache';
import { createRefreshWorker, playersToRefresh } from '../../src/jobs/refresh-worker';
import { GroupModel } from '../../src/modules/groups/group.model';
import { TrackedPlayerModel } from '../../src/modules/tracked-players/tracked-player.model';
import { AppError, notFound } from '../../src/shared/errors';
import { steamIdToAccountId } from '../../src/shared/schemas';
import { silentLogger, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock } from '../helpers/fetch-mock';

const id = (n: number) => String(76561198000000000n + BigInt(n));
const fresh = { isStale: false };
type Member = Awaited<ReturnType<Parameters<typeof createRefreshWorker>[0]['players']['member']>>;
const ok = () => ({ profile: fresh, history: fresh }) as unknown as Member;

const fakeLogger = () => {
  const child = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: { child: () => child } as unknown as Logger, child };
};

/** Résolu au n-ième appel du mock. */
const calledTimes = (mock: jest.Mock, n: number) =>
  new Promise<void>((resolve) => {
    const check = () => (mock.mock.calls.length >= n ? resolve() : setTimeout(check, 5));
    check();
  });

describe('Worker de préchauffage du cache', () => {
  useTestDb();

  const seed = async () => {
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    await TrackedPlayerModel.create([
      { ownerId: alice, steamId: id(3) },
      { ownerId: bob, steamId: id(3) },
      { ownerId: bob, steamId: id(1) },
    ]);
    await GroupModel.create([
      { ownerId: alice, name: 'a', steamIds: [id(1), id(2)] },
      { ownerId: bob, name: 'b', steamIds: [id(2), id(4)] },
    ]);
  };

  it('joueurs suivis et membres de groupes, tous comptes, sans doublon', async () => {
    await expect(playersToRefresh()).resolves.toEqual([]);
    await seed();
    await expect(playersToRefresh()).resolves.toEqual([id(1), id(2), id(3), id(4)]);
  });

  it('actualise chaque joueur une fois, au plus 2 en parallèle', async () => {
    await seed();
    let inFlight = 0;
    let peak = 0;
    const member = jest.fn(async (_steamId: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return ok();
    });
    const { logger, child } = fakeLogger();
    const report = await createRefreshWorker({
      players: { member },
      logger,
      intervalMs: 60_000,
    }).runOnce();
    expect(report).toEqual({ players: 4, refreshed: 4, failed: 0, aborted: false });
    expect(member.mock.calls.map(([s]) => s).sort()).toEqual([id(1), id(2), id(3), id(4)]);
    expect(peak).toBe(2);
    expect(child.info).toHaveBeenCalledWith(
      expect.objectContaining({ players: 4, durationMs: expect.any(Number) }),
      'Cycle de préchauffage terminé',
    );
  });

  it('aucun joueur → cycle vide', async () => {
    const member = jest.fn();
    const report = await createRefreshWorker({
      players: { member },
      logger: silentLogger,
      intervalMs: 60_000,
    }).runOnce();
    expect(report).toEqual({ players: 0, refreshed: 0, failed: 0, aborted: false });
    expect(member).not.toHaveBeenCalled();
  });

  it.each([
    ['limitation (503 Retry-After)', new AppError(503, 'SERVICE_UNAVAILABLE', 'x', 30)],
    ['erreur fournisseur (502)', new AppError(502, 'UPSTREAM_ERROR', 'x')],
  ])('%s → cycle interrompu', async (_label, error) => {
    await seed();
    const member = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(ok());
    const report = await createRefreshWorker({
      players: { member },
      logger: silentLogger,
      intervalMs: 60_000,
      concurrency: 1,
    }).runOnce();
    expect(report).toEqual({ players: 4, refreshed: 0, failed: 1, aborted: true });
    expect(member).toHaveBeenCalledTimes(1);
  });

  it('copie périmée servie (fournisseur en panne) → cycle interrompu', async () => {
    await seed();
    const member = jest
      .fn()
      .mockResolvedValueOnce({ profile: fresh, history: { isStale: true } })
      .mockResolvedValue(ok());
    const report = await createRefreshWorker({
      players: { member },
      logger: silentLogger,
      intervalMs: 60_000,
      concurrency: 1,
    }).runOnce();
    expect(report).toMatchObject({ refreshed: 0, failed: 0, aborted: true });
    expect(member).toHaveBeenCalledTimes(1);
  });

  it('joueur introuvable → compté en échec, journalisé, cycle poursuivi', async () => {
    await seed();
    const member = jest.fn().mockRejectedValueOnce(notFound('x')).mockResolvedValue(ok());
    const { logger, child } = fakeLogger();
    const report = await createRefreshWorker({
      players: { member },
      logger,
      intervalMs: 60_000,
      concurrency: 1,
    }).runOnce();
    expect(report).toEqual({ players: 4, refreshed: 3, failed: 1, aborted: false });
    expect(child.warn).toHaveBeenCalledWith(
      expect.objectContaining({ steamId: id(1) }),
      'Actualisation impossible',
    );
  });

  it('start : cycle immédiat puis cycles suivants ; start répété sans effet ; stop arrête tout', async () => {
    await seed();
    const member = jest.fn(async () => ok());
    const worker = createRefreshWorker({
      players: { member },
      logger: silentLogger,
      intervalMs: 20,
    });
    worker.start();
    worker.start();
    await calledTimes(member, 8);
    await worker.stop();
    const after = member.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(member.mock.calls.length).toBe(after);
  });

  it('stop pendant un cycle → attend sa fin et ne traite plus de nouveau joueur', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const member = jest.fn(async () => {
      await gate;
      return ok();
    });
    const worker = createRefreshWorker({
      players: { member },
      logger: silentLogger,
      intervalMs: 60_000,
      concurrency: 1,
    });
    worker.start();
    await calledTimes(member, 1);
    const stopping = worker.stop();
    release();
    await stopping;
    expect(member).toHaveBeenCalledTimes(1);
  });

  it('onCycleEnd appelé à chaque cycle planifié ; son échec est journalisé sans arrêter le worker', async () => {
    await seed();
    const member = jest.fn(async () => ok());
    const reports: unknown[] = [];
    const onCycleEnd = jest.fn((report: unknown) => {
      reports.push(report);
      if (reports.length === 1) throw new Error('disque plein');
    });
    const { logger, child } = fakeLogger();
    const worker = createRefreshWorker({ players: { member }, logger, intervalMs: 20, onCycleEnd });
    worker.start();
    await calledTimes(onCycleEnd, 2);
    await worker.stop();
    expect(reports[0]).toEqual({ players: 4, refreshed: 4, failed: 0, aborted: false });
    expect(child.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Heartbeat impossible',
    );
  });

  it('cycle en échec (base indisponible) → journalisé, cycle suivant planifié', async () => {
    await seed();
    jest.spyOn(TrackedPlayerModel, 'distinct').mockRejectedValueOnce(new Error('mongo down'));
    const member = jest.fn(async () => ok());
    const { logger, child } = fakeLogger();
    const worker = createRefreshWorker({ players: { member }, logger, intervalMs: 20 });
    worker.start();
    await calledTimes(member, 4);
    await worker.stop();
    expect(child.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Cycle de préchauffage en échec',
    );
  });

  it('intégration : historique et profil en cache, puis aucun appel tant que la copie est fraîche', async () => {
    const steamId = id(7);
    const accountId = steamIdToAccountId(steamId);
    await TrackedPlayerModel.create({ ownerId: new Types.ObjectId(), steamId });
    const upstream = createFetchMock()
      .on(/^\/v1\/players\/steam$/, {
        body: [{ account_id: accountId, personaname: 'P', avatarfull: null }],
      })
      .on(/match-history$/, { body: [] });
    const { players } = createServices({
      env: testEnv,
      logger: silentLogger,
      fetch: upstream.fetch,
    });
    const worker = createRefreshWorker({ players, logger: silentLogger, intervalMs: 60_000 });

    await expect(worker.runOnce()).resolves.toMatchObject({ refreshed: 1, aborted: false });
    const keys = (await ApiCacheModel.find({}, { key: 1 }).lean()).map((e) => e.key).sort();
    expect(keys).toEqual([`history:${accountId}`, `profile:${accountId}`]);

    const calls = upstream.calls.length;
    await worker.runOnce();
    expect(upstream.calls.length).toBe(calls);
  });
});
