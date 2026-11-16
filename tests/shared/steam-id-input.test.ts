import { normalizeSteamIdInput } from '../../src/shared/schemas';

const ID = '76561198957316510';

describe('normalizeSteamIdInput', () => {
  it.each([
    ['SteamID64', ID],
    ['SteamID64 avec espaces', `  ${ID} `],
    ['code ami', '997050782'],
    ['Steam3', '[U:1:997050782]'],
    ['Steam3 minuscule', '[u:1:997050782]'],
    ['URL de profil', `https://steamcommunity.com/profiles/${ID}`],
    ['URL avec www, slash et query', `http://www.steamcommunity.com/profiles/${ID}/?l=french`],
    ['URL sans schéma', `steamcommunity.com/profiles/${ID}#x`],
  ])('%s → SteamID64', (_label, input) => {
    expect(normalizeSteamIdInput(input)).toBe(ID);
  });

  it('codes ami extrêmes : 1 et 2^32 - 1', () => {
    expect(normalizeSteamIdInput('1')).toBe('76561197960265729');
    expect(normalizeSteamIdInput('4294967295')).toBe('76561202255233023');
  });

  it.each([
    ['vide', ''],
    ['code ami nul', '0'],
    ['code ami > 32 bits', '4294967296'],
    ['11 à 16 chiffres', '12345678901'],
    ['17 chiffres hors plage', '12345678901234567'],
    ['Steam3 nul', '[U:1:0]'],
    ['Steam3 d’un autre univers', '[U:2:5]'],
    ['URL personnalisée', 'https://steamcommunity.com/id/pseudo'],
    ['URL de profil hors plage', 'https://steamcommunity.com/profiles/12345678901234567'],
    ['autre domaine', `https://evil.test/profiles/${ID}`],
    ['pseudo', 'Corvid'],
  ])('%s → null', (_label, input) => {
    expect(normalizeSteamIdInput(input)).toBeNull();
  });
});
