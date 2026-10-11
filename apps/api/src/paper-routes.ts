import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StartPaperExperimentSchema } from '../../../packages/shared/src/paper-experiment-contracts.js';
import type { StrategyCatalogV1 } from './strategy-catalog.js';
import {
  PaperExperimentControllerError, type PaperExperimentControllerV1, type PaperExperimentRuntimeFactory,
} from './paper-execution/paper-experiment-controller.js';
import { listPythonStrategies } from './paper-execution/pine-paper-factory.js';
import { fetchVenueCatalog, type PaperVenueKey, type VenueMarket } from './paper-execution/venue-markets.js';
import { PaperExperimentActivityQueryError, readPaperExperimentActivityV1 } from './paper-execution/paper-experiment-activity.js';
import { readNautilusPaperSnapshot } from './paper-execution/nautilus-paper-ledger.js';

export function isCrossOriginPaperWrite(request: FastifyRequest): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = request.headers.origin;
  if (origin === undefined) return false; // Non-browser API clients do not send Origin.
  try {
    const parsed = new URL(origin);
    return (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.host !== request.headers.host;
  } catch {
    return true;
  }
}

export interface PaperRouteDependencies {
  readonly paperExperiments: PaperExperimentControllerV1;
  readonly paperRuntimeFactory: PaperExperimentRuntimeFactory | null;
  readonly paperRunsDir: string | null;
  readonly strategyPacks: readonly string[];
  readonly nautilusPython: string;
  readonly projectRoot: string;
  readonly getStrategyCatalog: () => StrategyCatalogV1 | null;
  /** False in the Pine-only public edition. */
  readonly pythonStrategies: boolean;
}

/** Paper control and inspection routes, served by the process that owns the runs. */
export function registerPaperRoutes(app: FastifyInstance, dependencies: PaperRouteDependencies): void {
  const {
    paperExperiments, paperRuntimeFactory, paperRunsDir, strategyPacks, nautilusPython, projectRoot, getStrategyCatalog,
    pythonStrategies,
  } = dependencies;
  let pythonStrategyCache: { at: number; value: Awaited<ReturnType<typeof listPythonStrategies>> } | null = null;
  app.get('/api/python-strategies', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!paperRuntimeFactory || !pythonStrategies) return { strategies: [], errors: [], packsConfigured: strategyPacks.length };
    try {
      if (!pythonStrategyCache || Date.now() - pythonStrategyCache.at > 15_000) {
        pythonStrategyCache = { at: Date.now(), value: await listPythonStrategies(nautilusPython, projectRoot, strategyPacks) };
      }
      return { ...pythonStrategyCache.value, packsConfigured: strategyPacks.length };
    } catch (error) {
      return reply.code(500).send({ kind: 'PYTHON_STRATEGIES_UNAVAILABLE',
        error: `Could not list Python strategies: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) });
    }
  });

  const venueCatalogCache = new Map<PaperVenueKey, { at: number; markets: VenueMarket[] }>();
  app.get<{ Querystring: { venue?: string } }>('/api/paper/markets', async (request, reply) => {
    const venue = request.query.venue;
    if (venue !== 'lighter' && venue !== 'hyperliquid') {
      return reply.code(400).send({ kind: 'INVALID_VENUE', error: 'venue must be lighter or hyperliquid.' });
    }
    const cached = venueCatalogCache.get(venue);
    try {
      if (!cached || Date.now() - cached.at > 10 * 60_000) {
        venueCatalogCache.set(venue, { at: Date.now(), markets: await fetchVenueCatalog(venue) });
      }
    } catch (error) {
      if (!cached) {
        return reply.code(502).send({ kind: 'VENUE_UNAVAILABLE',
          error: `Could not load ${venue} markets: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    reply.header('Cache-Control', 'no-store');
    const catalog = venueCatalogCache.get(venue)!.markets;
    return {
      venue, markets: catalog.map(({ market }) => market),
      // HIP-3 markets charge a multiple of the ordinary Hyperliquid fee.
      feeMultipliers: Object.fromEntries(catalog.filter(({ feeMultiplier }) => feeMultiplier !== 1)
        .map(({ market, feeMultiplier }) => [market, feeMultiplier])),
    };
  });

  app.get('/api/paper/capabilities', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return paperExperiments.capabilities();
  });

  app.get('/api/paper-experiments', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { experiments: paperExperiments.list() };
  });

  app.get<{ Params: { id: string } }>('/api/paper-experiments/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const experiment = paperExperiments.get(request.params.id);
    if (experiment && !experiment.runtime && paperRunsDir) {
      const directory = path.join(paperRunsDir, experiment.id);
      if (existsSync(path.join(directory, 'nautilus.sqlite'))) {
        try {
          const runtime = readNautilusPaperSnapshot(experiment, directory);
          return { experiment: runtime ? { ...experiment, runtime } : experiment };
        } catch (error) {
          app.log.warn({ err: error, experimentId: experiment.id }, 'Nautilus audit snapshot unavailable');
          // Control status remains usable; activity reports partial coverage rather than invented zero fills.
          return { experiment };
        }
      }
    }
    return experiment
      ? { experiment }
      : reply.code(404).send({ kind: 'PAPER_EXPERIMENT_NOT_FOUND', error: 'Paper experiment not found.' });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; fillsCursor?: string } }>(
    '/api/paper-experiments/:id/activity', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const experiment = paperExperiments.get(request.params.id);
      if (!experiment) return reply.code(404).send({ kind: 'PAPER_EXPERIMENT_NOT_FOUND', error: 'Paper experiment not found.' });
      const rawLimit = request.query.limit;
      if (rawLimit !== undefined && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
        return reply.code(400).send({ kind: 'INVALID_PAPER_ACTIVITY_QUERY', error: 'Invalid fill page size.' });
      }
      try {
        return { activity: readPaperExperimentActivityV1({ detail: experiment, runtimeDirectory: paperRunsDir,
          limit: rawLimit === undefined ? 20 : Number(rawLimit), fillsCursor: request.query.fillsCursor }) };
      } catch (error) {
        if (error instanceof PaperExperimentActivityQueryError) {
          return reply.code(400).send({ kind: 'INVALID_PAPER_ACTIVITY_QUERY', error: error.message });
        }
        throw error;
      }
    },
  );

  app.post('/api/paper-experiments', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) {
      return reply.code(403).send({ kind: 'PAPER_ORIGIN_FORBIDDEN', error: 'Paper changes require a same-origin request.' });
    }
    const parsed = StartPaperExperimentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'INVALID_PAPER_EXPERIMENT', error: 'Invalid Paper launch settings.', details: parsed.error.issues });
    }
    const catalog = getStrategyCatalog();
    if (!catalog) {
      return reply.code(422).send({ kind: 'PAPER_UNAVAILABLE', error: 'The saved-strategy catalog is not configured on this server.' });
    }
    try {
      const result = await paperExperiments.start(parsed.data, catalog.get(parsed.data.strategyId, parsed.data.version));
      return reply.code(result.existing ? 200 : 201).send({ experiment: result.experiment });
    } catch (error) {
      if (error instanceof PaperExperimentControllerError) {
        const status = error.kind === 'NOT_FOUND' ? 404
          : error.kind === 'PAPER_UNAVAILABLE' || error.kind === 'UNSUPPORTED_STRATEGY' ? 422
            : error.kind === 'PAPER_START_FAILED' ? 503 : 409;
        return reply.code(status).send({ kind: error.kind, error: error.message, ...(error.experiment ? { experiment: error.experiment } : {}) });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/paper-experiments/:id/stop', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (isCrossOriginPaperWrite(request)) {
      return reply.code(403).send({ kind: 'PAPER_ORIGIN_FORBIDDEN', error: 'Paper changes require a same-origin request.' });
    }
    try {
      return { experiment: await paperExperiments.stop(request.params.id) };
    } catch (error) {
      if (error instanceof PaperExperimentControllerError) {
        const status = error.kind === 'NOT_FOUND' ? 404 : error.kind === 'PAPER_STOP_FAILED' ? 503 : 409;
        return reply.code(status).send({ kind: error.kind, error: error.message, ...(error.experiment ? { experiment: error.experiment } : {}) });
      }
      throw error;
    }
  });
}
