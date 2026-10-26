import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Stops a run the ordinary way (a LIVE run closes its positions first) before the system runs out
 * of memory and kills it with no chance to close anything (2026-10-26: a Paper run grew to 6 GB
 * and the kernel killed it). Two rules, checked every 15 s on Linux:
 * - one run's engine process over its own limit (PSR_RUN_MEMORY_LIMIT_MB, default 2048);
 * - the whole server under its reserve of free memory (PSR_MIN_FREE_MEMORY_MB, default 1024):
 *   the largest run stops.
 * One run at a time; after a stop the reserve rule waits a minute for the memory to come back.
 */

export const DEFAULT_RUN_MEMORY_LIMIT_MB = 2048;
export const DEFAULT_MIN_FREE_MEMORY_MB = 1024;
const RESERVE_COOLDOWN_MS = 60_000;

export interface MemoryGuardLimits {
  readonly runMemoryLimitMb: number;
  readonly minFreeMemoryMb: number;
}

export function memoryGuardLimits(env: NodeJS.ProcessEnv = process.env): MemoryGuardLimits {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 64) throw new Error(`${name} must be a whole number of megabytes, at least 64.`);
    return value;
  };
  return { runMemoryLimitMb: read('PSR_RUN_MEMORY_LIMIT_MB', DEFAULT_RUN_MEMORY_LIMIT_MB),
    minFreeMemoryMb: read('PSR_MIN_FREE_MEMORY_MB', DEFAULT_MIN_FREE_MEMORY_MB) };
}

/** Which run to stop now and why, or null. `runs` are the active runs with their memory in MB. */
export function memoryGuardDecision(runs: readonly { readonly id: string; readonly rssMb: number }[], availableMb: number | null,
  limits: MemoryGuardLimits, options: { readonly reserveCooling?: boolean } = {}): { id: string; reason: string } | null {
  const largest = [...runs].sort((a, b) => b.rssMb - a.rssMb);
  const over = largest.find((run) => run.rssMb > limits.runMemoryLimitMb);
  if (over) {
    return { id: over.id, reason: `Memory guard: this run's engine used ${Math.round(over.rssMb)} MB, over its limit of `
      + `${limits.runMemoryLimitMb} MB; it was stopped the ordinary way before the server ran out of memory.` };
  }
  if (availableMb !== null && availableMb < limits.minFreeMemoryMb && largest.length && !options.reserveCooling) {
    return { id: largest[0]!.id, reason: `Memory guard: the server had ${Math.round(availableMb)} MB of free memory, under its reserve `
      + `of ${limits.minFreeMemoryMb} MB; the largest run (${Math.round(largest[0]!.rssMb)} MB) was stopped the ordinary way.` };
  }
  return null;
}

/** MemAvailable of /proc/meminfo in MB, or null. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const kb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  return kb ? Number(kb) / 1024 : null;
}

/** VmRSS of /proc/<pid>/status in MB, or null. */
export function parseVmRssMb(status: string): number | null {
  const kb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
  return kb ? Number(kb) / 1024 : null;
}

export interface MemoryGuardSources {
  /** Active runs this engine owns. */
  readonly activeRunIds: () => readonly string[];
  /** Stops a run the ordinary way with the given reason. */
  readonly stopRun: (id: string, reason: string) => Promise<unknown>;
  readonly runsDir: string;
  readonly limits?: MemoryGuardLimits;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Tests: memory readings instead of /proc. */
  readonly read?: () => Promise<{ readonly availableMb: number | null; readonly rssMb: (id: string) => Promise<number | null> }>;
}

async function procReader(runsDir: string) {
  const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
  return {
    availableMb: parseMemAvailableMb(meminfo),
    rssMb: async (id: string) => {
      try {
        const child = JSON.parse(await readFile(path.join(runsDir, id, 'nautilus-child.json'), 'utf8')) as { childPid?: unknown };
        if (!Number.isInteger(child.childPid)) return null;
        return parseVmRssMb(await readFile(`/proc/${child.childPid}/status`, 'utf8'));
      } catch {
        return null; // not started yet, or already gone
      }
    },
  };
}

export class MemoryGuard {
  readonly #sources: MemoryGuardSources;
  readonly #limits: MemoryGuardLimits;
  readonly #now: () => number;
  readonly #stopping = new Set<string>();
  #lastStopAt = -Infinity;
  #timer: NodeJS.Timeout | null = null;

  constructor(sources: MemoryGuardSources) {
    this.#sources = sources;
    this.#limits = sources.limits ?? memoryGuardLimits();
    this.#now = sources.now ?? Date.now;
  }

  /** Linux only (it reads /proc); elsewhere the guard stays off and says so. */
  start(intervalMs = 15_000): boolean {
    if (!this.#sources.read && (process.platform !== 'linux' || !existsSync('/proc/meminfo'))) {
      this.#sources.log?.('Memory guard is off: it needs Linux /proc.');
      return false;
    }
    this.#timer = setInterval(() => { void this.check(); }, intervalMs);
    this.#timer.unref();
    return true;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async check(): Promise<{ id: string; reason: string } | null> {
    const reader = await (this.#sources.read?.() ?? procReader(this.#sources.runsDir));
    const runs: { id: string; rssMb: number }[] = [];
    for (const id of this.#sources.activeRunIds()) {
      if (this.#stopping.has(id)) continue;
      const rssMb = await reader.rssMb(id);
      if (rssMb !== null) runs.push({ id, rssMb });
    }
    const decision = memoryGuardDecision(runs, reader.availableMb, this.#limits,
      { reserveCooling: this.#now() - this.#lastStopAt < RESERVE_COOLDOWN_MS || this.#stopping.size > 0 });
    if (!decision) return null;
    this.#stopping.add(decision.id);
    this.#lastStopAt = this.#now();
    this.#sources.log?.(`${decision.reason} (run ${decision.id})`);
    void this.#sources.stopRun(decision.id, decision.reason)
      .catch((error: unknown) => this.#sources.log?.(`Memory guard could not stop run ${decision.id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.#stopping.delete(decision.id));
    return decision;
  }
}
