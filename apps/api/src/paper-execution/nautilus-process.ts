import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/** Shared Nautilus process plumbing used by every Paper engine (Pine, Python, built-in). */
export const NAUTILUS_PAPER_VERSION = '2.0.0rc6.dev20260929';
export const NAUTILUS_FAST_PAPER_VERSION = '2.0.0rc6.dev20260929+hlfast5.1';

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * A Nautilus log line that must stop the run. A venue socket ending with a transport
 * error (e.g. Lighter's planned restart closes with code 1012) is not one: Nautilus
 * reconnects, and the runtime's own gap recovery pauses and resumes or fails the run.
 * Neither is a Lighter book subscription cancelled while it awaited the venue's reply: the
 * runtime's resubscribe of a market without data replaces it with a new subscription.
 */
export function isFatalNautilusLogLine(line: string): boolean {
  if (/nautilus_network::websocket::client: Received transport error, terminating/.test(line)) return false;
  if (/Failed to subscribe to Lighter book deltas: Client\("subscription cancelled before venue acknowledgement/.test(line)) return false;
  return /\[ERROR\]|InvalidStateTrigger|Traceback \(most recent call last\)/.test(line);
}

/** Experiment ids whose Nautilus process is owned by a live actor of this API (any factory). */
export const ownedNautilusRuns = new Set<string>();

/** A previous run's Nautilus process must be proven dead before its slot is reused. */
export function assertNoLiveNautilusProcess(runtimeDir: string): void {
  if (existsSync(runtimeDir)) {
    if (lstatSync(runtimeDir).isSymbolicLink()) throw new Error('Paper runtime root cannot be a symlink.');
    for (const item of readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const directory = path.join(runtimeDir, item.name);
      const identity = (name: 'nautilus-owner.json' | 'nautilus-child.json') => {
        const file = path.join(directory, name);
        if (!existsSync(file)) return null;
        if (!lstatSync(file).isFile()) throw new Error(`Invalid Nautilus process identity: ${name}.`);
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(file, 'utf8')); }
        catch { throw new Error(`Invalid Nautilus process identity: ${name}.`); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid Nautilus process identity: ${name}.`);
        const record = raw as Record<string, unknown>;
        if (record.experimentId !== item.name
          || !Number.isSafeInteger(record.parentPid) || (record.parentPid as number) < 1
          || !(record.childPid === null && name === 'nautilus-owner.json'
            || Number.isSafeInteger(record.childPid) && (record.childPid as number) > 0)) {
          throw new Error(`Invalid Nautilus process identity: ${name}.`);
        }
        return { parentPid: record.parentPid as number, childPid: record.childPid as number | null };
      };
      const ownerRecord = identity('nautilus-owner.json');
      const childRecord = identity('nautilus-child.json');
      if (ownerRecord && childRecord
        && (ownerRecord.parentPid !== childRecord.parentPid
          || ownerRecord.childPid !== null && ownerRecord.childPid !== childRecord.childPid)) {
        throw new Error('Nautilus API and child process identities disagree; Paper slot cannot be reused.');
      }
      // A parallel run this API still owns is not an orphan; every other live child blocks.
      if (ownedNautilusRuns.has(item.name)) continue;
      if ([ownerRecord?.childPid, childRecord?.childPid].some(pid => pid !== null && pid !== undefined && isAlive(pid))) {
        throw new Error('A previous Nautilus process is still alive. Its slot cannot be reused.');
      }
    }
  }
}

export async function checkNautilusRuntime(python: string, script: string, cwd: string,
  env: NodeJS.ProcessEnv, hyperliquidFastBook: boolean): Promise<void> {
  const version = hyperliquidFastBook ? NAUTILUS_FAST_PAPER_VERSION : NAUTILUS_PAPER_VERSION;
  const check = hyperliquidFastBook ? '--check-fast-book' : '--check';
  const marker = hyperliquidFastBook ? 'PSR_FAST_BOOK_OK' : 'PSR_RUNTIME_OK';
  const { stdout } = await promisify(execFile)(python, [script, check], { cwd, env, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (stdout.trim() !== `${marker}=${version}`) throw new Error('The qualified Nautilus runtime is not installed for the selected book mode.');
}
