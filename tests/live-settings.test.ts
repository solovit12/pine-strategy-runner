import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server.js';
import { registerLiveRoutes } from '../apps/api/src/live-routes.js';
import { LiveSettingsStore } from '../apps/api/src/live-settings.js';
import type { PaperExperimentControllerV1 } from '../apps/api/src/paper-execution/paper-experiment-controller.js';

/** Connecting a Lighter account for LIVE from the setup page: the key stays in a private file on this machine. */
const KEY = `0x${'5c'.repeat(40)}`; // a stand-in, never a real key
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function folder() {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-settings-'));
  temporary.push(directory);
  return directory;
}

async function routes(store: LiveSettingsStore, liveActive = false) {
  const app = Fastify();
  const checks: Array<Record<string, string>> = [];
  registerLiveRoutes(app, {
    store, nautilusPython: 'python', projectRoot: '.',
    paperExperiments: { capabilities: () => ({ liveActive }) } as unknown as PaperExperimentControllerV1,
    runCheck: async (env) => {
      checks.push(env);
      return { ok: true, balance: '99.5', openPositions: 0, openOrders: 0, error: null };
    },
  });
  await app.ready();
  return { app, checks };
}

const save = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({ method: 'PUT' as const, url: '/api/live/settings', payload: body, headers });

describe('LIVE settings', () => {
  it('saves the key into a private file and never returns it', async () => {
    const directory = path.join(folder(), 'live-secrets');
    const store = new LiveSettingsStore(directory, null, {});
    const { app } = await routes(store);
    expect((await app.inject({ method: 'GET', url: '/api/live/settings' })).json().settings)
      .toMatchObject({ exchange: 'lighter', enabled: false, keySaved: false, accountIndex: null });

    const saved = await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 123456, apiKeyIndex: 5, apiKey: KEY }));
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(KEY.slice(2, 22));
    expect(saved.json().settings).toEqual({ exchange: 'lighter', enabled: true, accountIndex: 123456, apiKeyIndex: 5,
      keySaved: true, keySource: 'app', disabledByServer: false });
    const file = path.join(directory, 'lighter-mainnet.env');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(`LIGHTER_ACCOUNT_INDEX=123456\nLIGHTER_API_KEY_INDEX=5\nLIGHTER_API_SECRET=${KEY}\n`);
    expect(store.liveTrading()).toBe(true);
    const read = await app.inject({ method: 'GET', url: '/api/live/settings' });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).not.toContain(KEY.slice(2, 22));

    // Saving again without a key keeps the saved one; switching off stops LIVE.
    const off = await app.inject(save({ exchange: 'lighter', enabled: false, accountIndex: 123456, apiKeyIndex: 6 }));
    expect(off.json().settings).toMatchObject({ enabled: false, apiKeyIndex: 6, keySaved: true });
    expect(readFileSync(file, 'utf8')).toContain(`LIGHTER_API_SECRET=${KEY}\n`);
    expect(store.liveTrading()).toBe(false);
  });

  it('refuses a bad key without echoing it, a cross-site write, and changes during a LIVE run', async () => {
    const store = new LiveSettingsStore(path.join(folder(), 'live-secrets'), null, {});
    const { app } = await routes(store);
    const bad = await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 5, apiKey: 'not-a-key-zzzz' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('not-a-key-zzzz');
    expect((await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 2, apiKey: KEY }))).statusCode)
      .toBe(400); // 0–3 belong to Lighter's own apps
    expect((await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 5 }))).json().error)
      .toBe('Enter the API private key.');
    expect((await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 5, apiKey: KEY },
      { origin: 'https://evil.example', host: 'localhost' }))).statusCode).toBe(403);
    expect(store.view().keySaved).toBe(false);

    const busy = await routes(store, true);
    const during = await busy.app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 5, apiKey: KEY }));
    expect(during.statusCode).toBe(409);
    expect((await busy.app.inject({ method: 'POST', url: '/api/live/check' })).statusCode).toBe(409);
  });

  it('checks the connection with the saved key and removes the key', async () => {
    const directory = path.join(folder(), 'live-secrets');
    const store = new LiveSettingsStore(directory, null, {});
    const { app, checks } = await routes(store);
    expect((await app.inject({ method: 'POST', url: '/api/live/check' })).json().error).toBe('Save the Lighter API key first.');
    await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 7, apiKeyIndex: 4, apiKey: KEY }));
    const check = await app.inject({ method: 'POST', url: '/api/live/check' });
    expect(check.json().check).toEqual({ ok: true, balance: '99.5', openPositions: 0, openOrders: 0, error: null });
    expect(check.body).not.toContain(KEY.slice(2, 22));
    expect(checks).toEqual([{ LIGHTER_ACCOUNT_INDEX: '7', LIGHTER_API_KEY_INDEX: '4', LIGHTER_API_SECRET: KEY }]);

    const removed = await app.inject({ method: 'DELETE', url: '/api/live/settings/key' });
    expect(removed.json().settings).toMatchObject({ enabled: false, keySaved: false });
    expect(existsSync(path.join(directory, 'lighter-mainnet.env'))).toBe(false);
  });

  it("uses a server operator's key as a fallback and honours the operator's off switch", () => {
    const base = folder();
    const server = path.join(base, 'etc-psr-secrets');
    mkdirSync(server);
    writeFileSync(path.join(server, 'lighter-mainnet.env'), `LIGHTER_ACCOUNT_INDEX=3\nLIGHTER_API_KEY_INDEX=9\nLIGHTER_API_SECRET=${KEY}\n`);
    // A server that switched LIVE on before this page existed (PSR_LIVE_ENABLED=1) keeps it on.
    const store = new LiveSettingsStore(path.join(base, 'live-secrets'), server, { PSR_LIVE_ENABLED: '1' });
    expect(store.view()).toMatchObject({ enabled: true, keySaved: true, keySource: 'server', accountIndex: 3, apiKeyIndex: 9 });
    expect(store.liveTrading()).toBe(true);
    store.removeKey(); // only the app's own file: the operator's stays
    expect(existsSync(path.join(server, 'lighter-mainnet.env'))).toBe(true);
    expect(new LiveSettingsStore(path.join(base, 'other'), server, { PSR_LIVE_ENABLED: '1', PSR_LIVE_DISABLED: '1' }).liveTrading())
      .toBe(false);
  });

  it('turns the LIVE choice on for the engine once an account is connected (both editions)', async () => {
    const base = folder();
    for (const edition of ['full', 'public'] as const) {
      const app = await buildApp({ edition, paperExperimentsDir: path.join(base, edition, 'control'),
        paperRunsDir: path.join(base, edition, 'runs'), liveSecretsDir: path.join(base, edition, 'live-secrets'), liveServerSecretsDir: null });
      try {
        const capabilities = async () => (await app.inject({ method: 'GET', url: '/api/paper/capabilities' })).json();
        expect((await capabilities()).liveTrading).toBe(false);
        const saved = await app.inject(save({ exchange: 'lighter', enabled: true, accountIndex: 1, apiKeyIndex: 4, apiKey: KEY }));
        expect(saved.statusCode, saved.body).toBe(200);
        expect((await capabilities()).liveTrading).toBe(true);
      } finally {
        await app.close();
      }
    }
  });
});
