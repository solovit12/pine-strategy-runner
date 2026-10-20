import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  CreateLiveAccountSchema, LIVE_ACCOUNT_ID_PATTERN, UpdateLiveAccountSchema, type LiveConnectionCheck, type LiveExchange,
} from '../../../packages/shared/src/paper-experiment-contracts.js';
import { LiveSettingsError, type LiveSettingsStore } from './live-settings.js';
import { isCrossOriginPaperWrite } from './paper-routes.js';

/** How long the read-only connection check may take (startup reconciliation included). */
const CHECK_TIMEOUT_MS = 120_000;

export interface LiveRouteDependencies {
  readonly store: LiveSettingsStore;
  readonly nautilusPython: string;
  readonly projectRoot: string;
  /** Tests replace the connection check. */
  readonly runCheck?: (env: Record<string, string>, exchange: LiveExchange) => Promise<LiveConnectionCheck>;
}

/** Runs apps/nautilus-paper/live_check.py: connects with the saved key, reads the account, places nothing. */
export function runLiveCheck(nautilusPython: string, projectRoot: string, env: Record<string, string>,
  exchange: LiveExchange = 'lighter'): Promise<LiveConnectionCheck> {
  const venue = exchange === 'hyperliquid' ? 'Hyperliquid' : 'Lighter';
  return new Promise((resolve) => {
    const child = spawn(nautilusPython, [path.join(projectRoot, 'apps/nautilus-paper/live_check.py'), '--network', 'mainnet',
      '--exchange', exchange, '--wait-secs', '5', '--reconcile-timeout', '60'], {
      cwd: projectRoot, env: { PATH: process.env.PATH ?? '', PYTHONUNBUFFERED: '1', ...env }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(-64_000); });
    const done = (error: string | null) => {
      clearTimeout(timer);
      const line = output.split('\n').find((row) => row.startsWith('PSR_LIVE_CHECK='));
      if (!line) return resolve({ ok: false, balance: null, openPositions: 0, openOrders: 0, exchange, error: error ?? `${venue} did not answer the check in time.` });
      try {
        const result = JSON.parse(line.slice('PSR_LIVE_CHECK='.length)) as {
          accountFound?: boolean; error?: string; balances?: Array<{ currency: string; total: string | null }>;
          openPositions?: unknown[]; openOrders?: unknown[]; dexBalances?: Record<string, string>;
        };
        // Nautilus writes money with its currency ("100.6 USDC"); the page adds the currency itself.
        const usdc = result.balances?.find((row) => row.currency === 'USDC')?.total?.replace(/ USDC$/, '') ?? null;
        resolve({
          ok: result.accountFound === true, balance: usdc, exchange,
          openPositions: result.openPositions?.length ?? 0, openOrders: result.openOrders?.length ?? 0,
          ...(result.dexBalances ? { dexBalances: result.dexBalances } : {}),
          error: result.accountFound ? null : (result.error ?? (exchange === 'hyperliquid'
            ? 'Hyperliquid did not accept this account address and API wallet key.'
            : 'Lighter did not accept this account index, API key index and key.')),
        });
      } catch {
        resolve({ ok: false, balance: null, openPositions: 0, openOrders: 0, exchange, error: 'The check returned an unreadable answer.' });
      }
    };
    child.on('error', (error) => done(`The check could not start: ${error.message}`));
    child.on('close', () => done(null));
  });
}

/** Live accounts, served by the process that owns the runs (the engine). */
export function registerLiveRoutes(app: FastifyInstance, dependencies: LiveRouteDependencies): void {
  const { store } = dependencies;
  const runCheck = dependencies.runCheck
    ?? ((env: Record<string, string>, exchange: LiveExchange) => runLiveCheck(dependencies.nautilusPython, dependencies.projectRoot, env, exchange));
  let checking = false;
  const forbidden = { kind: 'PAPER_ORIGIN_FORBIDDEN', error: 'Live accounts require a same-origin request.' };
  const refuse = (reply: FastifyReply, error: unknown) => {
    if (error instanceof LiveSettingsError) {
      return reply.code(error.status).send({ kind: error.status === 409 ? 'LIVE_ACCOUNT_CONFLICT' : error.status === 404
        ? 'LIVE_ACCOUNT_NOT_FOUND' : 'INVALID_LIVE_ACCOUNT', error: error.message });
    }
    throw error;
  };
  const idOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === 'string' && LIVE_ACCOUNT_ID_PATTERN.test(id) ? id : null;
  };

  app.get('/api/live/accounts', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.view();
  });

  app.post('/api/live/accounts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    // The key is never echoed back, not even in validation details.
    const parsed = CreateLiveAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      const hyperliquid = (request.body as { exchange?: unknown } | null)?.exchange === 'hyperliquid';
      return reply.code(400).send({ kind: 'INVALID_LIVE_ACCOUNT', error: hyperliquid
        ? 'Check the name, the account address (0x and 40 hexadecimal characters) and the API wallet private key.'
        : 'Check the name, the account index (a whole number), the API key index (4–254) and the API private key.' });
    }
    try {
      return { account: store.create(parsed.data) };
    } catch (error) { return refuse(reply, error); }
  });

  app.patch('/api/live/accounts/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    const id = idOf(request);
    if (!id) return reply.code(404).send({ kind: 'LIVE_ACCOUNT_NOT_FOUND', error: 'This account no longer exists.' });
    const parsed = UpdateLiveAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'INVALID_LIVE_ACCOUNT', error: 'Check the name (1–40 characters), the account index, the API key index (4–254), the address and the key.' });
    }
    try {
      return { account: store.update(id, parsed.data) };
    } catch (error) { return refuse(reply, error); }
  });

  app.delete('/api/live/accounts/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    const id = idOf(request);
    if (!id) return reply.code(404).send({ kind: 'LIVE_ACCOUNT_NOT_FOUND', error: 'This account no longer exists.' });
    try {
      store.remove(id);
      return store.view();
    } catch (error) { return refuse(reply, error); }
  });

  app.post('/api/live/accounts/:id/check', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    const id = idOf(request);
    const account = id ? store.account(id) : null;
    if (!id || !account) return reply.code(404).send({ kind: 'LIVE_ACCOUNT_NOT_FOUND', error: 'This account no longer exists.' });
    if (account.runId) {
      return reply.code(409).send({ kind: 'LIVE_ACCOUNT_CONFLICT', error: `A LIVE run is trading the account "${account.name}"; its page shows the balance and positions.` });
    }
    if (checking) return reply.code(409).send({ kind: 'LIVE_CHECK_RUNNING', error: 'A connection check is already running.' });
    let input: ReturnType<LiveSettingsStore['checkEnvironment']>;
    try {
      input = store.checkEnvironment(id);
    } catch (error) { return refuse(reply, error); }
    checking = true;
    try {
      return { check: await runCheck(input.env, input.exchange) };
    } finally {
      checking = false;
    }
  });
}
