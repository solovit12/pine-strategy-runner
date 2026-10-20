import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server.js';
import { registerLiveRoutes } from '../apps/api/src/live-routes.js';
import { LiveSettingsStore } from '../apps/api/src/live-settings.js';

/** Live accounts (Accounts page): each key stays in a private file of its own on this machine. */
const KEY = `0x${'5c'.repeat(40)}`; // a stand-in, never a real key
const HL_KEY = `0x${'7d'.repeat(32)}`; // a stand-in API wallet key
const HL_ADDRESS = `0x${'Ab'.repeat(20)}`;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function folder() {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-accounts-'));
  temporary.push(directory);
  return directory;
}

async function routes(store: LiveSettingsStore) {
  const app = Fastify();
  const checks: Array<Record<string, string>> = [];
  registerLiveRoutes(app, {
    store, nautilusPython: 'python', projectRoot: '.',
    runCheck: async (env, exchange) => {
      checks.push({ ...env, exchange });
      return { ok: true, balance: '99.5', openPositions: 0, openOrders: 0, error: null };
    },
  });
  await app.ready();
  return { app, checks };
}

const lighter = (changes: Record<string, unknown> = {}) => ({ method: 'POST' as const, url: '/api/live/accounts',
  payload: { exchange: 'lighter', name: 'Main', enabled: true, accountIndex: 123456, apiKeyIndex: 5, apiKey: KEY, ...changes } });
const hyperliquid = (changes: Record<string, unknown> = {}) => ({ method: 'POST' as const, url: '/api/live/accounts',
  payload: { exchange: 'hyperliquid', name: 'HL main', enabled: true, accountAddress: HL_ADDRESS, apiKey: HL_KEY, ...changes } });

describe('Live accounts', () => {
  it('adds an account: its key in a private file of its own, never returned', async () => {
    const directory = path.join(folder(), 'live-secrets');
    const store = new LiveSettingsStore(directory, null, {});
    const { app } = await routes(store);
    expect((await app.inject({ method: 'GET', url: '/api/live/accounts' })).json()).toEqual({ accounts: [], disabledByServer: false });
    expect(store.liveTrading()).toBe(false);

    const created = await app.inject(lighter());
    expect(created.statusCode, created.body).toBe(200);
    expect(created.body).not.toContain(KEY.slice(2, 22));
    const account = created.json().account;
    expect(account).toMatchObject({ name: 'Main', exchange: 'lighter', enabled: true, accountIndex: 123456, apiKeyIndex: 5,
      accountAddress: null, keySaved: true, keySource: 'app', runId: null });
    const file = path.join(directory, 'accounts', `${account.id}.env`);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(directory, 'accounts')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(`LIGHTER_ACCOUNT_INDEX=123456\nLIGHTER_API_KEY_INDEX=5\nLIGHTER_API_SECRET=${KEY}\n`);
    expect(readFileSync(path.join(directory, 'live.json'), 'utf8')).not.toContain(KEY.slice(2, 22));
    expect(store.liveExchanges()).toEqual(['lighter']);
    const read = await app.inject({ method: 'GET', url: '/api/live/accounts' });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).not.toContain(KEY.slice(2, 22));

    // Renaming and switching off keep the key; a run then cannot use it.
    const off = await app.inject({ method: 'PATCH', url: `/api/live/accounts/${account.id}`, payload: { name: 'Sub 1', enabled: false } });
    expect(off.json().account).toMatchObject({ name: 'Sub 1', enabled: false, keySaved: true });
    expect(readFileSync(file, 'utf8')).toContain(`LIGHTER_API_SECRET=${KEY}\n`);
    expect(store.liveTrading()).toBe(false);
    expect(() => store.accountForRun(account.id, 'lighter')).toThrow('LIVE is switched off for the account "Sub 1"');
    // A new API key index keeps the saved key under the new index.
    await app.inject({ method: 'PATCH', url: `/api/live/accounts/${account.id}`, payload: { apiKeyIndex: 6, enabled: true } });
    expect(readFileSync(file, 'utf8')).toContain(`LIGHTER_API_KEY_INDEX=6\nLIGHTER_API_SECRET=${KEY}\n`);
    expect(store.accountForRun(account.id, 'lighter')).toEqual({ id: account.id, name: 'Sub 1', exchange: 'lighter', file });

    const removed = await app.inject({ method: 'DELETE', url: `/api/live/accounts/${account.id}` });
    expect(removed.json().accounts).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a bad key without echoing it, a duplicate account or name, and a cross-site write', async () => {
    const store = new LiveSettingsStore(path.join(folder(), 'live-secrets'), null, {});
    const { app } = await routes(store);
    const bad = await app.inject(lighter({ apiKey: 'not-a-key-zzzz' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('not-a-key-zzzz');
    expect((await app.inject(lighter({ apiKeyIndex: 2 }))).statusCode).toBe(400); // 0–3 belong to Lighter's own apps
    expect((await app.inject(lighter({ apiKey: '' }))).json().error).toBe('Enter the API private key.');
    expect((await app.inject(lighter({ name: ' ' }))).statusCode).toBe(400);
    expect((await app.inject({ ...lighter(), headers: { origin: 'https://evil.example', host: 'localhost' } })).statusCode).toBe(403);
    expect(store.view().accounts).toEqual([]);

    expect((await app.inject(lighter())).statusCode).toBe(200);
    // One exchange account can be added once (two entries would let two runs trade it together).
    const twice = await app.inject(lighter({ name: 'Other', apiKeyIndex: 7 }));
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toMatch(/already added as "Main"/);
    expect((await app.inject(lighter({ name: 'main', accountIndex: 9 }))).json().error).toMatch(/named "main" already exists/);
    expect((await app.inject(lighter({ name: 'Sub', accountIndex: 9 }))).statusCode).toBe(200);
    expect((await app.inject(hyperliquid({ name: 'HL' }))).statusCode).toBe(200);
    expect((await app.inject(hyperliquid({ name: 'HL 2', accountAddress: HL_ADDRESS.toLowerCase() }))).statusCode).toBe(409);
    expect(store.view().accounts.map((account) => account.name)).toEqual(['Main', 'Sub', 'HL']);
  });

  it('keeps an account trading in a LIVE run as it is: only its name may change', async () => {
    const busy = new Map<string, string>();
    const store = new LiveSettingsStore(path.join(folder(), 'live-secrets'), null, {}, () => busy);
    const { app } = await routes(store);
    const account = (await app.inject(lighter())).json().account;
    busy.set(account.id, 'run-1');
    expect((await app.inject({ method: 'GET', url: '/api/live/accounts' })).json().accounts[0].runId).toBe('run-1');
    const url = `/api/live/accounts/${account.id}`;
    expect((await app.inject({ method: 'PATCH', url, payload: { apiKey: KEY } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url, payload: { enabled: false } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${url}/check` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url, payload: { name: 'Renamed' } })).json().account.name).toBe('Renamed');
  });

  it('checks the connection of one account with its own key', async () => {
    const store = new LiveSettingsStore(path.join(folder(), 'live-secrets'), null, {});
    const { app, checks } = await routes(store);
    const main = (await app.inject(lighter({ accountIndex: 7, apiKeyIndex: 4 }))).json().account;
    const hl = (await app.inject(hyperliquid({ apiKey: HL_KEY.slice(2) }))).json().account;
    expect(hl).toMatchObject({ accountAddress: HL_ADDRESS.toLowerCase(), keySaved: true });

    const check = await app.inject({ method: 'POST', url: `/api/live/accounts/${main.id}/check` });
    expect(check.json().check).toEqual({ ok: true, balance: '99.5', openPositions: 0, openOrders: 0, error: null });
    expect(check.body).not.toContain(KEY.slice(2, 22));
    await app.inject({ method: 'POST', url: `/api/live/accounts/${hl.id}/check` });
    expect(checks).toEqual([
      { LIGHTER_ACCOUNT_INDEX: '7', LIGHTER_API_KEY_INDEX: '4', LIGHTER_API_SECRET: KEY, exchange: 'lighter' },
      { HYPERLIQUID_PK: HL_KEY, HYPERLIQUID_ACCOUNT_ADDRESS: HL_ADDRESS.toLowerCase(), exchange: 'hyperliquid' },
    ]);
    expect((await app.inject({ method: 'POST', url: '/api/live/accounts/missing-account/check' })).statusCode).toBe(404);
    expect(store.liveExchanges()).toEqual(['lighter', 'hyperliquid']);
    expect(() => store.accountForRun(hl.id, 'lighter')).toThrow('is not a Lighter account');
    expect(() => store.accountForRun(undefined, 'hyperliquid')).toThrow('Choose the Hyperliquid account');
  });

  it('turns the keys of before accounts into accounts: the app\'s own file moves, the operator\'s stays', () => {
    const base = folder();
    const directory = path.join(base, 'live-secrets');
    const server = path.join(base, 'etc-psr-secrets');
    mkdirSync(directory);
    mkdirSync(server);
    writeFileSync(path.join(server, 'lighter-mainnet.env'), `LIGHTER_ACCOUNT_INDEX=3\nLIGHTER_API_KEY_INDEX=9\nLIGHTER_API_SECRET=${KEY}\n`);
    writeFileSync(path.join(directory, 'hyperliquid-mainnet.env'), `HYPERLIQUID_ACCOUNT_ADDRESS=${HL_ADDRESS}\nHYPERLIQUID_PK=${HL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(directory, 'live.json'), JSON.stringify({ exchange: 'lighter', enabled: true, hyperliquid: { enabled: true } }));
    const store = new LiveSettingsStore(directory, server, {});
    const [main, hl] = store.view().accounts;
    expect(main).toMatchObject({ name: 'Lighter main', exchange: 'lighter', enabled: true, accountIndex: 3, apiKeyIndex: 9,
      keySaved: true, keySource: 'server' });
    expect(hl).toMatchObject({ name: 'Hyperliquid main', exchange: 'hyperliquid', enabled: true,
      accountAddress: HL_ADDRESS.toLowerCase(), keySaved: true, keySource: 'app' });
    expect(existsSync(path.join(server, 'lighter-mainnet.env'))).toBe(true);
    expect(existsSync(path.join(directory, 'hyperliquid-mainnet.env'))).toBe(false);
    expect(readFileSync(path.join(directory, 'accounts', `${hl!.id}.env`), 'utf8')).toContain(`HYPERLIQUID_PK=${HL_KEY}`);
    expect(store.accountForRun(main!.id, 'lighter').file).toBe(path.join(server, 'lighter-mainnet.env'));
    expect(store.legacyAccountId('lighter')).toBe(main!.id);
    // Once only: the same accounts on the next start, and the operator's key cannot be replaced here.
    expect(new LiveSettingsStore(directory, server, {}).view().accounts.map((account) => account.id)).toEqual([main!.id, hl!.id]);
    expect(() => store.update(main!.id, { apiKey: KEY })).toThrow('set up by the server operator');
    store.remove(main!.id);
    expect(existsSync(path.join(server, 'lighter-mainnet.env'))).toBe(true);

    // A server that switched LIVE on before the settings file existed (PSR_LIVE_ENABLED=1) keeps it on.
    const old = path.join(base, 'old');
    mkdirSync(old);
    writeFileSync(path.join(old, 'lighter-mainnet.env'), `LIGHTER_ACCOUNT_INDEX=4\nLIGHTER_API_KEY_INDEX=5\nLIGHTER_API_SECRET=${KEY}\n`);
    expect(new LiveSettingsStore(old, null, { PSR_LIVE_ENABLED: '1' }).liveExchanges()).toEqual(['lighter']);
    expect(new LiveSettingsStore(old, null, { PSR_LIVE_DISABLED: '1' }).liveTrading()).toBe(false);
  });

  it('turns the LIVE choice on for the engine once an account is added (both editions)', async () => {
    const base = folder();
    for (const edition of ['full', 'public'] as const) {
      const app = await buildApp({ edition, paperExperimentsDir: path.join(base, edition, 'control'),
        paperRunsDir: path.join(base, edition, 'runs'), liveSecretsDir: path.join(base, edition, 'live-secrets'), liveServerSecretsDir: null });
      try {
        const capabilities = async () => (await app.inject({ method: 'GET', url: '/api/paper/capabilities' })).json();
        expect((await capabilities()).liveTrading).toBe(false);
        const created = await app.inject(lighter({ accountIndex: 1, apiKeyIndex: 4 }));
        expect(created.statusCode, created.body).toBe(200);
        expect(await capabilities()).toMatchObject({ liveTrading: true, liveExchanges: ['lighter'], maxConcurrentExperiments: 6 });
      } finally {
        await app.close();
      }
    }
  });
});
