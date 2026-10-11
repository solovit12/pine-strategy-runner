import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../apps/api/src/server.js';

describe('public Binance Futures backtester ignores obsolete 0xArchive credentials', () => {
  let credentialsDirectory: string;

  beforeEach(async () => {
    credentialsDirectory = await mkdtemp(path.join(tmpdir(), 'pine-oxa-credential-'));
    vi.stubEnv('OXA_API_KEY', '');
    vi.stubEnv('CREDENTIALS_DIRECTORY', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(credentialsDirectory, { recursive: true, force: true });
  });

  it('runs without an API key or systemd credential', async () => {
    const app = await buildApp();
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().historicalData).toEqual({
        provider: 'Binance Futures', venue: 'binance', configured: true,
      });
    } finally {
      await app.close();
    }
  });

  it.each(['test-key', 'test-key\n', 'test-key\r\n'])(
    'ignores a pre-existing systemd credential with optional final newline',
    async (contents) => {
      await writeFile(path.join(credentialsDirectory, 'oxa_api_key'), contents);
      vi.stubEnv('CREDENTIALS_DIRECTORY', credentialsDirectory);
      const app = await buildApp();
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health' });
        expect(health.json().historicalData.configured).toBe(true);
        expect(health.body).not.toContain('test-key');
      } finally {
        await app.close();
      }
    },
  );

  it('does not require a valid credential file even when an old environment key exists', async () => {
    await writeFile(path.join(credentialsDirectory, 'oxa_api_key'), 'bad credential');
    vi.stubEnv('CREDENTIALS_DIRECTORY', credentialsDirectory);
    vi.stubEnv('OXA_API_KEY', ' environment-key ');
    const app = await buildApp();
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().historicalData.configured).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each(['', '\n', 'bad credential', 'key\n\n', 'key\0'])
    ('ignores an empty or malformed old systemd credential', async (contents) => {
      await writeFile(path.join(credentialsDirectory, 'oxa_api_key'), contents);
      vi.stubEnv('CREDENTIALS_DIRECTORY', credentialsDirectory);
      const app = await buildApp();
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health' });
        expect(health.json().historicalData.configured).toBe(true);
        expect(health.body).not.toContain('oxa_api_key');
      } finally {
        await app.close();
      }
    });

  it('starts if the old credentials directory is configured without a file', async () => {
    vi.stubEnv('CREDENTIALS_DIRECTORY', credentialsDirectory);
    const app = await buildApp();
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().historicalData.configured).toBe(true);
    } finally {
      await app.close();
    }
  });
});
