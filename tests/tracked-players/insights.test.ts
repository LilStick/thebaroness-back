import request from 'supertest';
import { TrackedPlayerModel } from '../../src/modules/tracked-players/tracked-player.model';
import { TRACKED_MAX } from '../../src/modules/tracked-players/tracked-player.service';
import { buildTestApp, createUser } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const BASE = 76561197960265728n;
const OK = '76561197960265829'; // account 101
const MISSING = '76561197960265830'; // account 102
const NO_HISTORY = '76561197960265831'; // account 103
const account = (steamId: string) => Number(BigInt(steamId) - BASE);
const NOW_S = Math.floor(Date.now() / 1000);

const history = Array.from({ length: 12 }, (_, i) => ({
  match_id: 500 - i,
  hero_id: 1,
  start_time: NOW_S - i * 3600,
  player_kills: 1,
  player_deaths: 1,
  player_assists: 1,
  // 3 premières : victoires, puis alternance.
  player_match_outcome: i < 3 || i % 2 ? 1 : 2,
  ranked_display_badge: i === 2 ? 92 : 0,
}));

describe('GET /api/tracked-players/insights (synthétique)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/players\/steam$/, (url) => {
        const id = Number(url.searchParams.get('account_ids'));
        return {
          body: id === account(MISSING) ? [] : [{ account_id: id, personaname: `P${id}` }],
        };
      })
      .on(new RegExp(`/players/${account(OK)}/match-history$`), { body: history })
      .on(new RegExp(`/players/${account(NO_HISTORY)}/match-history$`), { status: 503 })
      .on(/^\/v1\/assets\/ranks$/, {
        body: [{ tier: 9, name: 'Augure', images: { large_webp: 'https://r.test/9.webp' } }],
      });
    app = buildTestApp({}, upstream.fetch);
  });

  const track = async (ownerId: string, steamIds: string[]) =>
    TrackedPlayerModel.insertMany(steamIds.map((steamId) => ({ ownerId, steamId })));

  it('une carte par suivi ; joueur introuvable ou indisponible isolé, liste jamais en échec', async () => {
    const alice = await createUser();
    await track(alice.userId, [OK, MISSING, NO_HISTORY]);
    const res = await request(app).get('/api/tracked-players/insights').set(alice.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, truncated: false, meta: { isPartial: true } });
    const byId = Object.fromEntries(res.body.items.map((i: { steamId: string }) => [i.steamId, i]));

    expect(byId[OK]).toMatchObject({
      status: 'ok',
      player: { displayName: `P${account(OK)}` },
      rank: { badgeId: 92, tier: 9, subrank: 2 },
      lastMatchAt: new Date(NOW_S * 1000).toISOString(),
      form: {
        results: ['win', 'win', 'win', 'win', 'loss', 'win', 'loss', 'win', 'loss', 'win'],
        wins: 7,
        losses: 3,
        winRate: 70,
        sampleSize: 10,
        requestedSize: 10,
      },
      error: null,
    });
    expect(byId[OK].form.matchIds[0]).toBe('500');

    expect(byId[MISSING]).toMatchObject({
      status: 'not_found',
      player: null,
      form: null,
      error: { code: 'NOT_FOUND' },
    });
    // Historique en échec : identité conservée, forme et rang inconnus (null, jamais 0).
    expect(byId[NO_HISTORY]).toMatchObject({
      status: 'partial',
      player: { displayName: `P${account(NO_HISTORY)}` },
      rank: null,
      lastMatchAt: null,
      form: null,
      error: null,
    });
  });

  it('seulement ses propres suivis ; sans JWT → 401 ; liste vide → items vides', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await track(alice.userId, [OK]);
    const res = await request(app).get('/api/tracked-players/insights').set(bob.auth);
    expect(res.body).toMatchObject({ items: [], total: 0, meta: { isPartial: false } });
    expect((await request(app).get('/api/tracked-players/insights')).status).toBe(401);
  });

  it('second appel servi par le cache partagé : aucun appel source supplémentaire', async () => {
    const alice = await createUser();
    await track(alice.userId, [OK]);
    await request(app).get('/api/tracked-players/insights').set(alice.auth);
    const before = upstream.calls.length;
    await request(app).get('/api/tracked-players/insights').set(alice.auth);
    expect(upstream.calls.length).toBe(before);
  });

  it(`création au-delà de ${TRACKED_MAX} suivis → 409 TRACKED_LIMIT_REACHED`, async () => {
    const alice = await createUser();
    await track(
      alice.userId,
      Array.from({ length: TRACKED_MAX }, (_, i) => String(76561198000000000n + BigInt(i))),
    );
    const res = await request(app)
      .post('/api/tracked-players')
      .set(alice.auth)
      .send({ steamId: '76561198100000000' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRACKED_LIMIT_REACHED');
  });
});
