import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { SaveLiveSettingsSchema, type LiveConnectionCheck } from '../../../packages/shared/src/paper-experiment-contracts.js';
import { LiveSettingsError, type LiveSettingsStore } from './live-settings.js';
import type { PaperExperimentControllerV1 } from './paper-execution/paper-experiment-controller.js';
import { isCrossOriginPaperWrite } from './paper-routes.js';

/** How long the read-only connection check may take (startup reconciliation included). */
const CHECK_TIMEOUT_MS = 120_000;

export interface LiveRouteDependencies {
  readonly store: LiveSettingsStore;
  readonly paperExperiments: PaperExperimentControllerV1;
  readonly nautilusPython: string;
  readonly projectRoot: string;
  /** Tests replace the connection check. */
  readonly runCheck?: (env: Record<string, string>) => Promise<LiveConnectionCheck>;
}

/** Runs apps/nautilus-paper/live_check.py: connects with the saved key, reads the account, places nothing. */
export function runLiveCheck(nautilusPython: string, projectRoot: string, env: Record<string, string>): Promise<LiveConnectionCheck> {
  return new Promise((resolve) => {
    const child = spawn(nautilusPython, [path.join(projectRoot, 'apps/nautilus-paper/live_check.py'), '--network', 'mainnet',
      '--wait-secs', '5', '--reconcile-timeout', '60'], {
      cwd: projectRoot, env: { PATH: process.env.PATH ?? '', PYTHONUNBUFFERED: '1', ...env }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(-64_000); });
    const done = (error: string | null) => {
      clearTimeout(timer);
      const line = output.split('\n').find((row) => row.startsWith('PSR_LIVE_CHECK='));
      if (!line) return resolve({ ok: false, balance: null, openPositions: 0, openOrders: 0, error: error ?? 'Lighter did not answer the check in time.' });
      try {
        const result = JSON.parse(line.slice('PSR_LIVE_CHECK='.length)) as {
          accountFound?: boolean; error?: string; balances?: Array<{ currency: string; total: string | null }>;
          openPositions?: unknown[]; openOrders?: unknown[];
        };
        const usdc = result.balances?.find((row) => row.currency === 'USDC')?.total ?? null;
        resolve({
          ok: result.accountFound === true, balance: usdc,
          openPositions: result.openPositions?.length ?? 0, openOrders: result.openOrders?.length ?? 0,
          error: result.accountFound ? null : (result.error ?? 'Lighter did not accept this account index, API key index and key.'),
        });
      } catch {
        resolve({ ok: false, balance: null, openPositions: 0, openOrders: 0, error: 'The check returned an unreadable answer.' });
      }
    };
    child.on('error', (error) => done(`The check could not start: ${error.message}`));
    child.on('close', () => done(null));
  });
}

/** Live trading settings, served by the process that owns the runs (the engine). */
export function registerLiveRoutes(app: FastifyInstance, dependencies: LiveRouteDependencies): void {
  const { store, paperExperiments } = dependencies;
  const runCheck = dependencies.runCheck
    ?? ((env: Record<string, string>) => runLiveCheck(dependencies.nautilusPython, dependencies.projectRoot, env));
  let checking = false;
  const liveRunActive = () => Boolean(paperExperiments.capabilities().liveActive);
  const forbidden = { kind: 'PAPER_ORIGIN_FORBIDDEN', error: 'Live settings require a same-origin request.' };

  app.get('/api/live/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { settings: store.view() };
  });

  app.put('/api/live/settings', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    // The key is never echoed back, not even in validation details.
    const parsed = SaveLiveSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'INVALID_LIVE_SETTINGS',
        error: 'Check the account index (a whole number), the API key index (4–254) and the API private key.' });
    }
    if (liveRunActive()) {
      return reply.code(409).send({ kind: 'LIVE_RUN_ACTIVE', error: 'Stop the LIVE run before changing its account settings.' });
    }
    try {
      return { settings: store.save(parsed.data) };
    } catch (error) {
      if (error instanceof LiveSettingsError) return reply.code(400).send({ kind: 'INVALID_LIVE_SETTINGS', error: error.message });
      throw error;
    }
  });

  app.delete('/api/live/settings/key', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    if (liveRunActive()) {
      return reply.code(409).send({ kind: 'LIVE_RUN_ACTIVE', error: 'Stop the LIVE run before removing its key.' });
    }
    return { settings: store.removeKey() };
  });

  app.post('/api/live/check', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) return reply.code(403).send(forbidden);
    if (liveRunActive()) {
      return reply.code(409).send({ kind: 'LIVE_RUN_ACTIVE', error: 'A LIVE run is using the account; its page shows the balance and positions.' });
    }
    if (checking) return reply.code(409).send({ kind: 'LIVE_CHECK_RUNNING', error: 'A connection check is already running.' });
    let env: Record<string, string>;
    try {
      env = store.checkEnvironment();
    } catch (error) {
      if (error instanceof LiveSettingsError) return reply.code(400).send({ kind: 'INVALID_LIVE_SETTINGS', error: error.message });
      throw error;
    }
    checking = true;
    try {
      return { check: await runCheck(env) };
    } finally {
      checking = false;
    }
  });
}
