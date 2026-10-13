import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoLiveNautilusProcess, isFatalNautilusLogLine, ownedNautilusRuns } from '../apps/api/src/paper-execution/nautilus-process.js';

describe('Nautilus Paper slot ownership', () => {
  it('lets a parallel launch past a live child only while this API still owns that run', () => {
    const runtimeDir = mkdtempSync(path.join(tmpdir(), 'psr-owned-'));
    const id = randomUUID();
    mkdirSync(path.join(runtimeDir, id));
    writeFileSync(path.join(runtimeDir, id, 'nautilus-owner.json'), JSON.stringify({
      experimentId: id, parentPid: process.pid, childPid: process.pid, exited: false,
    }));
    try {
      ownedNautilusRuns.add(id);
      expect(() => assertNoLiveNautilusProcess(runtimeDir)).not.toThrow();
      ownedNautilusRuns.delete(id);
      expect(() => assertNoLiveNautilusProcess(runtimeDir)).toThrow(/still alive/);
    } finally {
      ownedNautilusRuns.delete(id);
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

describe('Nautilus log lines that stop a Paper run', () => {
  it('leaves a venue socket transport error to gap recovery and still stops on other errors', () => {
    // Lighter's planned restart (2026-10-09) closed its socket with code 1012; Nautilus reconnects.
    const lighterRestart = '\u001b[1m2026-10-09T12:22:15.577869000Z\u001b[0m \u001b[1;31m[ERROR] PSR-PAPER-001.nautilus_network::websocket::client: '
      + 'Received transport error, terminating: transport error: Invalid close code: 1012\u001b[0m';
    expect(isFatalNautilusLogLine(lighterRestart)).toBe(false);
    expect(isFatalNautilusLogLine('[ERROR] PSR-PAPER-001.nautilus_execution::engine: order rejected unexpectedly')).toBe(true);
    // Run 8da27e00 (2026-10-13): a resubscribe cancelled Lighter's own pending subscription.
    expect(isFatalNautilusLogLine('\u001b[1m2026-10-13T00:55:41.279544664Z\u001b[0m \u001b[1;31m[ERROR] PSR-PAPER-001.nautilus_lighter::data: '
      + 'Failed to subscribe to Lighter book deltas: Client("subscription cancelled before venue acknowledgement: order_book:39")\u001b[0m')).toBe(false);
    expect(isFatalNautilusLogLine('[ERROR] PSR-PAPER-001.nautilus_lighter::data: Failed to subscribe to Lighter book deltas: Client("invalid market")')).toBe(true);
    expect(isFatalNautilusLogLine('Traceback (most recent call last):')).toBe(true);
    expect(isFatalNautilusLogLine('InvalidStateTrigger: RUNNING -> START')).toBe(true);
    expect(isFatalNautilusLogLine('[WARN] PSR-PAPER-001.nautilus_lighter::websocket::handler: Lighter WS unparsed frame')).toBe(false);
  });
});
