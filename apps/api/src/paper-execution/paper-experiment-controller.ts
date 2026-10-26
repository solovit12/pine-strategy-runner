import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pineCodeError } from '../../../../packages/pine-runtime/src/pine-errors.js';
import {
  LIVE_ALREADY_ACTIVE_MESSAGE,
  MAX_CONCURRENT_PAPER_EXPERIMENTS,
  liveAccountBusyMessage,
  type PaperExperimentCapabilities,
  type PaperExperimentDetail,
  type PaperExperimentStatus,
  type PaperExperimentSummary,
  type PaperExperimentTrack,
  type LiveExchange,
  type PaperExperimentRuntimeView,
  StartPaperExperimentSchema,
  type StartPaperExperimentRequest,
} from '../../../../packages/shared/src/paper-experiment-contracts.js';
import {
  MAX_MARKETS_PER_RUN, MAX_MARKETS_PER_VENUE, type StrategyDetail,
} from '../../../../packages/shared/src/strategy-catalog-contracts.js';
import {
  liveAccountConflict,
  PaperExperimentStoreError,
  PaperExperimentStoreV1,
  type PaperExperimentSnapshot,
} from './paper-experiment-store.js';
import { nativeLaunchRefusal } from './native-strategies.js';
import { PINE_ONLY_MESSAGE } from '../../../../packages/shared/src/edition.js';

const UNAVAILABLE_REASON = 'Paper launch is not enabled on this server.';
const USER_STOP_REASON = 'Stopped before a completed Paper run.';
/** Reason of a run that the system stopped (server shutdown or restart), not the owner. */
export const SERVER_SHUTDOWN_REASON = 'Server shutdown: the system stopped the engine.';
/** Runs stopped by a shutdown, started again by the next engine within this time. */
export const RESUME_AFTER_RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;
const RESUME_FILE = 'resume-after-restart.json';

export interface ResumeAfterRestartResult {
  readonly stoppedId: string;
  readonly resumedId?: string;
  readonly error?: string;
}

export type PaperExperimentControllerErrorKind =
  | 'PAPER_UNAVAILABLE'
  | 'UNSUPPORTED_STRATEGY'
  | 'SOURCE_VERSION_CONFLICT'
  | 'PAPER_EXPERIMENT_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PAPER_NOT_OWNER'
  | 'PAPER_START_FAILED'
  | 'PAPER_STOP_FAILED'
  | 'NOT_FOUND';

export class PaperExperimentControllerError extends Error {
  constructor(readonly kind: PaperExperimentControllerErrorKind, message: string, readonly experiment?: PaperExperimentDetail) {
    super(message);
    this.name = 'PaperExperimentControllerError';
  }
}

export type PaperTrackUpdate = Partial<Pick<
  PaperExperimentTrack,
  'status' | 'reason' | 'events' | 'signals' | 'intents' | 'fills'
>>;

/**
 * Only a final, non-revocable physical shutdown proof may release the global
 * slot. A supervisor whose proof can be withdrawn by a late callback cannot
 * implement this contract until it excludes that callback race.
 */
export type PaperExperimentStopProof =
  | { readonly outcome: 'completed'; readonly controlSlotReleaseProven: true;
    readonly finalVenueDrainProven: true; readonly reason: null }
  | { readonly outcome: 'interrupted'; readonly controlSlotReleaseProven: true;
    readonly finalVenueDrainProven: false; readonly reason: string };

export interface PaperExperimentRuntimeHandle {
  /** Stop real market feeds and all paper sessions; never only change a UI flag. */
  /** `reason` is set when the system, not the owner, stops the run (a server shutdown). */
  stop(reason?: string): Promise<PaperExperimentStopProof>;
  /** Optional read-only view from the live owner; never inferred from control timestamps. */
  snapshot?(): PaperExperimentRuntimeView;
}

/** Injection seam: only a fully validated, actual execution owner may implement this. */
export interface PaperExperimentRuntimeFactory {
  /** Narrower admission limits for an explicitly qualified pilot. */
  readonly admissionLimits?: Readonly<Pick<PaperExperimentCapabilities,
    'maxTracksPerVenue' | 'maxTracksPerExperiment' | 'allowedMarkets'>>;
  preflight(snapshot: Omit<PaperExperimentSnapshot, 'experimentId' | 'accounts' | 'tracks' | 'createdAt'>): Promise<void>;
  /** Prove that a partially started owner can no longer trade after start rejects. */
  abortStart(snapshot: PaperExperimentSnapshot): Promise<Extract<PaperExperimentStopProof, { outcome: 'interrupted' }>>;
  start(
    snapshot: PaperExperimentSnapshot,
    reportTrack: (trackId: string, update: PaperTrackUpdate) => void,
  ): Promise<PaperExperimentRuntimeHandle>;
}

interface ManagedExperiment {
  handle: PaperExperimentRuntimeHandle | null;
  stopRequested: boolean;
  terminalStatus: 'completed' | 'interrupted';
  terminalReason: string | null;
  /** A system stop's reason (memory guard) that the runtime keeps in its final reason. */
  systemStopReason: string | null;
  snapshot: PaperExperimentSnapshot | null;
  startFailed: boolean;
  startPromise: Promise<PaperExperimentRuntimeHandle> | null;
  stopPromise: Promise<PaperExperimentDetail> | null;
}

function aggregateStatus(experiment: PaperExperimentDetail): PaperExperimentStatus {
  const statuses = experiment.tracks.map((track) => track.status);
  // A single ambiguous market event invalidates the whole shared-account run.
  if (statuses.includes('interrupted')) return 'interrupted';
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('recovering')) return 'recovering';
  if (statuses.includes('warming_up')) return 'warming_up';
  if (statuses.includes('waiting_for_data')) return 'waiting_for_data';
  return 'preparing';
}

/** One local API-process owner. No browser lifetime, external orders or credentials. */
export class PaperExperimentControllerV1 {
  readonly #store: PaperExperimentStoreV1 | null;
  readonly #directory: string | null;
  readonly #now: () => number;
  readonly #factory: PaperExperimentRuntimeFactory | null;
  readonly #catalogConfigured: boolean;
  readonly #pythonStrategies: boolean;
  readonly #liveTrading: () => boolean;
  readonly #liveExchanges: () => readonly LiveExchange[];
  readonly #liveAccountName: (id: string) => string | null;
  readonly #legacyLiveAccountId: (exchange: LiveExchange) => string | null;
  readonly #liveLoadRefusal: (settings: StartPaperExperimentRequest['settings']) => Promise<string | null>;
  #otherLiveOwnerReason: string | null = null;
  readonly #managed = new Map<string, ManagedExperiment>();

  constructor(options: {
    readonly directory: string | null;
    readonly catalogConfigured: boolean;
    readonly runtimeFactory?: PaperExperimentRuntimeFactory | null;
    readonly now?: () => number;
    /** False in the Pine-only public edition. */
    readonly pythonStrategies?: boolean;
    /** Live trading with real money: full edition with PSR_LIVE_ENABLED=1 on this engine. */
    readonly liveTrading?: boolean | (() => boolean);
    /** Exchanges with a connected, switched-on Live account. */
    readonly liveExchanges?: () => readonly LiveExchange[];
    /** A Live account's name for messages (Accounts page). */
    readonly liveAccountName?: (id: string) => string | null;
    /** The account made from an exchange's single key of before accounts: what an older Live run trades. */
    readonly legacyLiveAccountId?: (exchange: LiveExchange) => string | null;
    /** Why a new Live run must not start for an exchange limit (exchange-load.ts), or null. */
    readonly liveLoadRefusal?: (settings: StartPaperExperimentRequest['settings']) => Promise<string | null>;
  }) {
    this.#store = options.directory ? new PaperExperimentStoreV1(options.directory, options.now) : null;
    this.#directory = options.directory;
    this.#now = options.now ?? Date.now;
    this.#factory = options.runtimeFactory ?? null;
    this.#catalogConfigured = options.catalogConfigured;
    this.#pythonStrategies = options.pythonStrategies ?? true;
    const live = options.liveTrading ?? false;
    this.#liveTrading = typeof live === 'function' ? live : () => live;
    this.#liveExchanges = options.liveExchanges ?? (() => (this.#liveTrading() ? ['lighter'] : []));
    this.#liveAccountName = options.liveAccountName ?? (() => null);
    this.#legacyLiveAccountId = options.legacyLiveAccountId ?? (() => null);
    this.#liveLoadRefusal = options.liveLoadRefusal ?? (async () => null);
    if (this.#store) {
      try {
        // The previous process may have died after taking a Gateway batch.
        // Only a proven-dead local PID is interrupted; a live owner is never stolen.
        this.#store.reconcileAfterRestart();
      } catch (error) {
        if (error instanceof PaperExperimentStoreError && error.kind === 'EXPERIMENT_LIMIT' && !this.#factory) {
          // Read-only API may coexist with a live owner. Its active row remains
          // visible, while this process cannot admit or stop that runtime.
          this.#otherLiveOwnerReason = error.message;
        } else {
          this.#store.close();
          throw error;
        }
      }
    }
  }

  /** Live account id -> the active Live run trading it (an older run trades its exchanges' first accounts). */
  busyLiveAccounts(): Map<string, string> {
    const busy = new Map<string, string>();
    for (const run of this.#store?.activeLiveRuns() ?? []) {
      const ids = run.accounts ? Object.values(run.accounts)
        : run.venues.map((venue) => this.#legacyLiveAccountId(venue));
      for (const id of ids) if (id) busy.set(id, run.id);
    }
    return busy;
  }

  capabilities(): PaperExperimentCapabilities {
    const reason = !this.#store
      ? 'Paper experiment storage is not configured on this server.'
      : this.#otherLiveOwnerReason
        ? this.#otherLiveOwnerReason
      : !this.#catalogConfigured
        ? 'The saved-strategy catalog is not configured on this server.'
      : !this.#factory
        ? UNAVAILABLE_REASON
        : this.#store.activeExperimentCount() >= MAX_CONCURRENT_PAPER_EXPERIMENTS
          ? `${MAX_CONCURRENT_PAPER_EXPERIMENTS} Paper experiments are already active. Open Paper Runs to inspect or stop one.`
        : null;
    return {
      available: reason === null,
      reason,
      maxTracksPerVenue: this.#factory?.admissionLimits?.maxTracksPerVenue ?? MAX_MARKETS_PER_VENUE,
      maxTracksPerExperiment: this.#factory?.admissionLimits?.maxTracksPerExperiment ?? MAX_MARKETS_PER_RUN,
      maxConcurrentExperiments: MAX_CONCURRENT_PAPER_EXPERIMENTS,
      activeExperiments: this.#store?.activeExperimentCount() ?? 0,
      liveTrading: this.#liveTrading(),
      liveExchanges: this.#liveTrading() ? [...this.#liveExchanges()] : [],
      ...(this.#factory?.admissionLimits?.allowedMarkets
        ? { allowedMarkets: this.#factory.admissionLimits.allowedMarkets } : {}),
    };
  }

  list(): PaperExperimentSummary[] { return this.#store?.list() ?? []; }

  get(id: string): PaperExperimentDetail | null {
    const detail = this.#store?.get(id) ?? null;
    if (!detail) return null;
    const owner = this.#managed.get(id)?.handle;
    if (!owner?.snapshot) return detail;
    try {
      return { ...detail, runtime: owner.snapshot() };
    } catch {
      // The control record remains readable while an owner is failing closed.
      return detail;
    }
  }

  async start(
    request: StartPaperExperimentRequest,
    saved: StrategyDetail | null,
    options: { readonly resumed?: boolean } = {},
  ): Promise<{ readonly experiment: PaperExperimentDetail; readonly existing: boolean }> {
    if (!saved || saved.strategy.id !== request.strategyId || saved.version.version !== request.version) {
      throw new PaperExperimentControllerError('NOT_FOUND', 'The requested saved strategy version was not found.');
    }
    if (saved.version.sourceSha256 !== request.sourceSha256) {
      throw new PaperExperimentControllerError('SOURCE_VERSION_CONFLICT', 'The saved Pine source hash changed; reload the exact version before starting.');
    }
    const savedModel = 'accountModel' in saved.version.paperSettings ? saved.version.paperSettings.accountModel : null;
    if (savedModel !== 'venue_shared_v2' && savedModel !== 'pine_live_v1' && savedModel !== 'python_live_v1') {
      throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', 'This saved strategy has an older Paper draft. Prepare Paper again and save the new settings before launch.');
    }
    if (savedModel === 'python_live_v1' && !this.#pythonStrategies) {
      throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', PINE_ONLY_MESSAGE);
    }
    if (request.settings.accountModel !== savedModel) {
      throw new PaperExperimentControllerError('SOURCE_VERSION_CONFLICT', 'Paper launch settings differ from the saved version. Save the changes as a new version before launch.');
    }
    if ('live' in request.settings && request.settings.live && !this.#liveTrading()) {
      throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', 'Live trading is not enabled on this engine.');
    }
    const nativeRefusal = savedModel === 'venue_shared_v2'
      ? nativeLaunchRefusal({ sourceSha256: saved.version.sourceSha256, origin: saved.version.metadata.origin },
        request.settings.tracks.map(({ market }) => market))
      : null;
    if (nativeRefusal) throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', nativeRefusal);
    // A mistake in the Pine code is explained before an engine is started for it.
    const codeError = savedModel === 'pine_live_v1' ? pineCodeError(saved.version.source) : null;
    if (codeError) throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', codeError.message);
    if (!this.#store || !this.#factory) {
      throw new PaperExperimentControllerError('PAPER_UNAVAILABLE', this.capabilities().reason ?? UNAVAILABLE_REASON);
    }
    // A selection has no caller-defined order. Keep the saved execution order
    // for exact settings checks and durable request hashes, including retries.
    const savedTrackOrder = new Map(saved.version.paperSettings.tracks.map((track, index) =>
      [`${track.venue}:${track.market}`, index]));
    request = { ...request, settings: { ...request.settings,
      tracks: request.settings.tracks.toSorted((left, right) =>
        (savedTrackOrder.get(`${left.venue}:${left.market}`) ?? savedTrackOrder.size)
        - (savedTrackOrder.get(`${right.venue}:${right.market}`) ?? savedTrackOrder.size)),
    } } as StartPaperExperimentRequest;
    let prior: PaperExperimentDetail | null;
    try {
      prior = this.#store.findByIdempotency(request);
    } catch (error) {
      if (error instanceof PaperExperimentStoreError && error.kind === 'IDEMPOTENCY_CONFLICT') {
        throw new PaperExperimentControllerError('IDEMPOTENCY_CONFLICT', error.message);
      }
      throw error;
    }
    if (prior) {
      if (prior.status === 'interrupted') {
        throw new PaperExperimentControllerError('PAPER_START_FAILED', 'That launch failed and was cleaned up. Start a new attempt to retry.', prior);
      }
      if (prior.status === 'stopping') {
        throw new PaperExperimentControllerError('PAPER_EXPERIMENT_LIMIT', 'The earlier launch is still stopping; its execution owner has not been proven closed.', prior);
      }
      return { experiment: prior, existing: true };
    }
    if ('live' in request.settings && request.settings.live) {
      const conflict = liveAccountConflict(request.settings.live.accounts, this.#store.activeLiveRuns());
      if (conflict === 'legacy') throw new PaperExperimentControllerError('PAPER_EXPERIMENT_LIMIT', LIVE_ALREADY_ACTIVE_MESSAGE);
      if (conflict) {
        throw new PaperExperimentControllerError('PAPER_EXPERIMENT_LIMIT', liveAccountBusyMessage(this.#liveAccountName(conflict) ?? conflict));
      }
      // A run resumed after a restart was already trading: it is not judged again.
      const loadRefusal = options.resumed ? null : await this.#liveLoadRefusal(request.settings);
      if (loadRefusal) throw new PaperExperimentControllerError('PAPER_EXPERIMENT_LIMIT', loadRefusal);
    }
    if (JSON.stringify(saved.version.paperSettings) !== JSON.stringify(request.settings)) {
      throw new PaperExperimentControllerError('SOURCE_VERSION_CONFLICT', 'Paper launch settings differ from the saved version. Save the changes as a new version before launch.');
    }
    const fees = request.settings.accountModel !== 'venue_shared_v2'
      ? [request.settings.hyperliquidMakerFeePercent, request.settings.hyperliquidTakerFeePercent,
        request.settings.lighterMakerFeePercent, request.settings.lighterTakerFeePercent]
      : [request.settings.hyperliquidMakerEntryFeePercent, request.settings.hyperliquidTakerExitFeePercent,
        request.settings.lighterMakerEntryFeePercent, request.settings.lighterTakerExitFeePercent];
    if (fees.some((fee) => fee === null || fee === undefined)) {
      throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', 'Enter separate maker-entry and taker-exit Paper fees for both exchanges before launch.');
    }
    const proposed = {
      strategyId: request.strategyId,
      strategyVersion: request.version,
      strategyName: saved.version.name,
      source: saved.version.source,
      sourceSha256: request.sourceSha256,
      settings: request.settings,
    };
    try {
      await this.#factory.preflight(proposed);
    } catch (error) {
      throw new PaperExperimentControllerError('UNSUPPORTED_STRATEGY', error instanceof Error ? error.message : String(error));
    }
    let reserved: { readonly experiment: PaperExperimentDetail; readonly existing: boolean };
    try {
      reserved = this.#store.reserve({
        request,
        strategyName: saved.version.name,
        source: saved.version.source,
      });
    } catch (error) {
      if (error instanceof PaperExperimentStoreError) {
        if (error.kind === 'EXPERIMENT_LIMIT') throw new PaperExperimentControllerError('PAPER_EXPERIMENT_LIMIT', error.message);
        if (error.kind === 'IDEMPOTENCY_CONFLICT') throw new PaperExperimentControllerError('IDEMPOTENCY_CONFLICT', error.message);
      }
      throw error;
    }
    if (reserved.existing) return reserved;
    const id = reserved.experiment.id;
    const managed: ManagedExperiment = {
      handle: null,
      stopRequested: false,
      terminalStatus: 'completed',
      terminalReason: null,
      systemStopReason: null,
      snapshot: null,
      startFailed: false,
      startPromise: null,
      stopPromise: null,
    };
    this.#managed.set(id, managed);
    try {
      const snapshot = this.#store.snapshot(id)!;
      managed.snapshot = snapshot;
      managed.startPromise = this.#factory.start(snapshot, (trackId, update) => this.#reportTrack(id, trackId, update));
      const handle = await managed.startPromise;
      managed.handle = handle;
      if (managed.stopRequested) {
        void this.#stopManaged(id, managed).catch(() => undefined);
      } else if (this.#store.get(id)?.status === 'completed' || this.#store.get(id)?.status === 'interrupted') {
        void this.#stopManaged(id, managed).catch(() => undefined);
      } else if (this.#store.get(id)?.status === 'preparing') {
        this.#store.setStatus(id, 'waiting_for_data');
      }
      return { experiment: this.#store.get(id)!, existing: false };
    } catch (error) {
      managed.startFailed = true;
      const reason = `Paper runtime could not start: ${error instanceof Error ? error.message : String(error)}`;
      managed.terminalReason = reason;
      try {
        await this.#abortFailedStart(id, managed);
      } catch {
        // The active slot stays occupied until cleanup can be proven.
      }
      const failed = this.#store.get(id)!;
      throw new PaperExperimentControllerError('PAPER_START_FAILED', failed.reason ?? reason, failed);
    }
  }

  /** Runs this engine is running now and nobody has asked to stop. */
  runningIds(): string[] {
    return [...this.#managed].filter(([, managed]) => managed.handle && !managed.stopRequested).map(([id]) => id);
  }

  /** `systemReason`: the system, not the owner, stops the run (memory guard); it is not resumed. */
  async stop(id: string, systemReason?: string): Promise<PaperExperimentDetail> {
    const experiment = this.get(id);
    if (!experiment) throw new PaperExperimentControllerError('NOT_FOUND', 'Paper experiment not found.');
    if (experiment.status === 'completed' || experiment.status === 'interrupted') return experiment;
    const managed = this.#managed.get(id);
    if (!managed) {
      throw new PaperExperimentControllerError('PAPER_NOT_OWNER', 'This API process does not own the active Paper runtime.');
    }
    managed.stopRequested = true;
    managed.terminalStatus = 'interrupted';
    if (systemReason) {
      managed.terminalReason ??= systemReason;
      managed.systemStopReason ??= systemReason;
    }
    managed.terminalReason ??= USER_STOP_REASON;
    if (!managed.handle) {
      if (managed.startFailed) return this.#abortFailedStart(id, managed);
      return this.#store!.setStatus(id, 'stopping');
    }
    return this.#stopManaged(id, managed);
  }

  async close(): Promise<void> {
    const ids = [...this.#managed.keys()];
    // A shutdown is not the owner's Stop: say so, and let the next engine start these runs again.
    const resume = ids.filter((id) => !this.#managed.get(id)!.stopRequested);
    for (const id of resume) this.#managed.get(id)!.terminalReason = SERVER_SHUTDOWN_REASON;
    if (resume.length && this.#directory) {
      try {
        writeFileSync(path.join(this.#directory, RESUME_FILE), JSON.stringify({ at: this.#now(), ids: resume }), { mode: 0o600 });
      } catch { /* the runs still stop; they are just not resumed */ }
    }
    await Promise.allSettled([...this.#managed.values()].map((managed) => managed.startPromise));
    const stops = await Promise.allSettled(ids.map((id) => this.stop(id)));
    const pendingStops = await Promise.allSettled([...this.#managed.values()].map((managed) => managed.stopPromise));
    const failed = [...stops, ...pendingStops].find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected' || this.#managed.size !== 0) {
      // Never close the control journal while an execution owner may still be
      // alive. The caller can retry close after a confirmed stop.
      throw failed?.status === 'rejected'
        ? failed.reason
        : new PaperExperimentControllerError('PAPER_STOP_FAILED', 'A Paper runtime is still stopping.');
    }
    this.#store?.close();
  }

  /**
   * Start again the runs that the previous engine stopped for a server shutdown: same saved
   * strategy version and settings, a new run. Only an orderly shutdown within the window
   * qualifies; the file is removed first, so a failing start is never retried in a loop.
   */
  async resumeAfterRestart(saved: (strategyId: string, version: number) => StrategyDetail | null): Promise<ResumeAfterRestartResult[]> {
    if (!this.#directory || !this.#store || !this.#factory) return [];
    const file = path.join(this.#directory, RESUME_FILE);
    let entry: { at?: unknown; ids?: unknown };
    try {
      entry = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return [];
    } finally {
      rmSync(file, { force: true });
    }
    if (typeof entry.at !== 'number' || !Array.isArray(entry.ids)
      || this.#now() - entry.at > RESUME_AFTER_RESTART_WINDOW_MS) return [];
    const results: ResumeAfterRestartResult[] = [];
    for (const stoppedId of entry.ids.filter((id): id is string => typeof id === 'string')) {
      try {
        const stopped = this.#store.get(stoppedId);
        if (!stopped || stopped.status !== 'interrupted' || !stopped.reason?.startsWith(SERVER_SHUTDOWN_REASON)) {
          results.push({ stoppedId, error: 'not stopped by a server shutdown' });
          continue;
        }
        const strategy = saved(stopped.strategyId, stopped.strategyVersion);
        const request = StartPaperExperimentSchema.parse({
          strategyId: stopped.strategyId, version: stopped.strategyVersion, sourceSha256: stopped.sourceSha256,
          settings: strategy?.version.paperSettings, idempotencyKey: randomUUID(),
        });
        const { experiment } = await this.start(request, strategy, { resumed: true });
        results.push({ stoppedId, resumedId: experiment.id });
      } catch (error) {
        results.push({ stoppedId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  #reportTrack(id: string, trackId: string, update: PaperTrackUpdate): void {
    const store = this.#store;
    if (!store) return;
    const before = store.get(id);
    if (!before || before.status === 'completed' || before.status === 'interrupted') return;
    const updated = store.updateTrack(id, trackId, update);
    const managed = this.#managed.get(id);
    if (update.status === 'interrupted' && managed) {
      managed.terminalStatus = 'interrupted';
      // A later track can report a shutdown symptom after another track has
      // already reported the fault that interrupted the experiment.
      if (!managed.terminalReason || managed.terminalReason === USER_STOP_REASON) {
        managed.terminalReason = update.reason ?? 'One Paper track was interrupted.';
      }
    }
    if (updated.status === 'stopping') return;
    const aggregate = aggregateStatus(updated);
    if (aggregate === 'completed' || aggregate === 'interrupted') {
      if (!managed) return;
      managed.stopRequested = true;
      if (aggregate === 'interrupted') {
        managed.terminalStatus = 'interrupted';
        managed.terminalReason ??= 'One or more Paper tracks was interrupted.';
      }
      store.setStatus(id, 'stopping', managed.terminalReason);
      if (managed.handle) void this.#stopManaged(id, managed).catch(() => undefined);
    } else if (aggregate !== updated.status) {
      store.setStatus(id, aggregate);
    }
  }

  #stopManaged(id: string, managed: ManagedExperiment): Promise<PaperExperimentDetail> {
    if (managed.stopPromise) return managed.stopPromise;
    managed.stopPromise = (async () => {
      this.#store!.setStatus(id, 'stopping', managed.terminalReason);
      try {
        const proof = await managed.handle!.stop(managed.terminalReason === SERVER_SHUTDOWN_REASON ? SERVER_SHUTDOWN_REASON
          : managed.systemStopReason ?? undefined);
        if (!proof || proof.controlSlotReleaseProven !== true
          || (proof.outcome === 'completed' && (proof.finalVenueDrainProven !== true || proof.reason !== null))
          || (proof.outcome === 'interrupted'
            && (proof.finalVenueDrainProven !== false || !proof.reason))
          || (proof.outcome !== 'completed' && proof.outcome !== 'interrupted')) {
          throw new Error('Paper runtime did not prove a releasable two-venue shutdown.');
        }
        if (proof.outcome === 'interrupted') {
          managed.terminalStatus = 'interrupted';
          // The runtime's reason may extend a system reason with the LIVE closes' outcome.
          if (!managed.terminalReason || managed.terminalReason === USER_STOP_REASON
            || proof.reason.startsWith(managed.terminalReason)) {
            managed.terminalReason = proof.reason;
          } else if (!managed.terminalReason.includes(proof.reason)) {
            managed.terminalReason += `; ${proof.reason}`;
          }
        }
        const detail = this.#store!.setStatus(id, managed.terminalStatus, managed.terminalReason);
        this.#managed.delete(id);
        return detail;
      } catch (error) {
        // The executor may still be live. Keep the active slot occupied until
        // a later stop succeeds or process death is proven on restart.
        const detail = this.#store!.setStatus(id, 'stopping', `Paper runtime stop failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new PaperExperimentControllerError('PAPER_STOP_FAILED', detail.reason ?? 'Paper runtime stop failed.', detail);
      }
    })();
    const attempt = managed.stopPromise;
    void attempt.catch(() => {
      if (managed.stopPromise === attempt) managed.stopPromise = null;
    });
    return managed.stopPromise;
  }

  #abortFailedStart(id: string, managed: ManagedExperiment): Promise<PaperExperimentDetail> {
    if (managed.stopPromise) return managed.stopPromise;
    managed.stopPromise = (async () => {
      this.#store!.setStatus(id, 'stopping', managed.terminalReason);
      try {
        if (!managed.snapshot) throw new Error('The pinned startup snapshot is unavailable.');
        const proof = await this.#factory!.abortStart(managed.snapshot);
        if (!proof || proof.outcome !== 'interrupted' || proof.controlSlotReleaseProven !== true
          || proof.finalVenueDrainProven !== false || !proof.reason) {
          throw new Error('Failed-start owner did not prove a releasable interrupted shutdown.');
        }
        const detail = this.#store!.setStatus(id, 'interrupted', managed.terminalReason);
        this.#managed.delete(id);
        return detail;
      } catch (error) {
        const detail = this.#store!.setStatus(id, 'stopping',
          `Cannot confirm failed-start cleanup: ${error instanceof Error ? error.message : String(error)}`);
        throw new PaperExperimentControllerError('PAPER_STOP_FAILED', detail.reason ?? 'Failed-start cleanup is unconfirmed.', detail);
      }
    })();
    const attempt = managed.stopPromise;
    void attempt.catch(() => {
      if (managed.stopPromise === attempt) managed.stopPromise = null;
    });
    return managed.stopPromise;
  }
}
