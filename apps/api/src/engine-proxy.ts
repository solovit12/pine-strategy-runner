import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_CONCURRENT_PAPER_EXPERIMENTS,
  type PaperExperimentCapabilities,
} from '../../../packages/shared/src/paper-experiment-contracts.js';
import { MAX_MARKETS_PER_RUN, MAX_MARKETS_PER_VENUE } from '../../../packages/shared/src/strategy-catalog-contracts.js';
import { isCrossOriginPaperWrite } from './paper-routes.js';

/**
 * The site and the Paper engine are separate processes so that restarting the
 * site never stops a running Paper experiment. The site forwards every Paper
 * request to the engine on this machine with a shared secret.
 */
export const ENGINE_TOKEN_HEADER = 'x-psr-engine-token';
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8788';
const PAPER_PATHS = ['/api/paper/*', '/api/paper-experiments', '/api/paper-experiments/*', '/api/python-strategies', '/api/live/*'];
const ENGINE_DOWN = 'The Paper engine is not running. Backtests and the strategy library still work.';

export interface EngineConnection {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export function readEngineToken(file: string): string {
  const token = readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error('The Paper engine token file must hold at least 32 characters.');
  return token;
}

export function engineTokenMatches(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function engineFetch(engine: EngineConnection, url: string, init: RequestInit = {}): Promise<Response> {
  return (engine.fetch ?? fetch)(new URL(url, engine.url), {
    ...init,
    headers: { ...init.headers as Record<string, string>, [ENGINE_TOKEN_HEADER]: engine.token },
  });
}

export function unavailableCapabilities(reason = ENGINE_DOWN): PaperExperimentCapabilities {
  return {
    available: false, reason, maxTracksPerVenue: MAX_MARKETS_PER_VENUE, maxTracksPerExperiment: MAX_MARKETS_PER_RUN,
    maxConcurrentExperiments: MAX_CONCURRENT_PAPER_EXPERIMENTS,
  };
}

/** The engine's admission state, or a not-running answer when it cannot be reached. */
export async function engineStatus(engine: EngineConnection):
  Promise<{ readonly reachable: boolean; readonly capabilities: PaperExperimentCapabilities }> {
  try {
    const response = await engineFetch(engine, '/api/paper/capabilities', { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { reachable: false, capabilities: unavailableCapabilities(`The Paper engine answered HTTP ${response.status}.`) };
    }
    return { reachable: true, capabilities: await response.json() as PaperExperimentCapabilities };
  } catch {
    return { reachable: false, capabilities: unavailableCapabilities() };
  }
}

export function registerEngineProxy(app: FastifyInstance, engine: EngineConnection): void {
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    // The engine only sees the site, so the browser-origin check happens here.
    if (request.method !== 'GET' && isCrossOriginPaperWrite(request)) {
      return reply.code(403).send({ kind: 'PAPER_ORIGIN_FORBIDDEN', error: 'Paper changes require a same-origin request.' });
    }
    const hasBody = request.body !== undefined && request.body !== null;
    let response: Response;
    try {
      response = await engineFetch(engine, request.url, {
        method: request.method,
        headers: hasBody ? { 'content-type': 'application/json' } : {},
        body: hasBody ? JSON.stringify(request.body) : undefined,
        // A launch waits for preflight and process start; reads stay short.
        signal: AbortSignal.timeout(request.method === 'GET' ? 15_000 : 180_000),
      });
    } catch {
      if (request.url.startsWith('/api/paper/capabilities')) return reply.send(unavailableCapabilities());
      return reply.code(503).send({ kind: 'PAPER_ENGINE_UNAVAILABLE', error: ENGINE_DOWN });
    }
    const type = response.headers.get('content-type');
    if (type) reply.type(type);
    return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
  };
  for (const url of PAPER_PATHS) app.all(url, forward);
}
