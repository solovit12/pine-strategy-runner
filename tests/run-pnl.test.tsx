import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PaperRunHistory } from '../apps/web/src/components/PaperRuns.js';
import { venueTotalPnl } from '../packages/shared/src/paper-pnl.js';
import type { PaperExperimentDetail, PaperExperimentSummary } from '../packages/shared/src/paper-experiment-contracts.js';

const account = (venue: 'Hyperliquid' | 'Lighter', cashBalance: string, extra: Record<string, unknown> = {}) => ({
  venue, accountId: `${venue}-1`, runId: 'r', cashBalance, brokerRevision: 0, publicFrames: 0, pendingOrders: 0,
  signals: 0, intents: 0, fills: 0, rejectedSignals: 0, positions: [], ...extra,
});
const accounts = [
  { venue: 'Hyperliquid' as const, accountId: 'Hyperliquid-1', runId: 'r', currency: 'USDC' as const, startingCash: 1000 },
  { venue: 'Lighter' as const, accountId: 'Lighter-1', runId: 'r', currency: 'USDC' as const, startingCash: 1000 },
];

describe('Total PnL per exchange (Runs list)', () => {
  it('Paper: equity against the virtual start; LIVE: against the real start, only the run\'s exchanges', () => {
    const tracks = [{ venue: 'Hyperliquid', market: 'SOL' }] as unknown as PaperExperimentDetail['tracks'];
    const runtime = { stage: 'running', fundingTreatment: 'excluded', observedAt: '', accounts: [
      account('Hyperliquid', '1010', { positions: [{ market: 'SOL', side: 'long', remainingBaseQuantity: '1', unrealizedPnl: '-2.5' }] }),
      account('Lighter', '990'),
    ] } as unknown as PaperExperimentDetail['runtime'];
    expect(venueTotalPnl({ accounts, tracks, runtime })).toEqual([
      { venue: 'Hyperliquid', total: 7.5, percent: 0.75 }, { venue: 'Lighter', total: -10, percent: -1 }]);
    const live = { stage: 'running', fundingTreatment: 'excluded', observedAt: '', accounts: [
      account('Hyperliquid', '100.45', { startBalance: '100.60' }), account('Lighter', '10000')] } as unknown as PaperExperimentDetail['runtime'];
    const [row, ...rest] = venueTotalPnl({ accounts, tracks, runtime: live, live: true });
    expect(rest).toEqual([]);
    expect(row!.venue).toBe('Hyperliquid');
    expect(row!.total).toBeCloseTo(-0.15, 6);
    expect(venueTotalPnl({ accounts, tracks, runtime: undefined })).toEqual([]);
  });

  it('shows the totals of every exchange of a run after its status', () => {
    const run = { id: 'r1', strategyId: 's', strategyVersion: 1, strategyName: 'Breakouts', sourceSha256: 'x', status: 'running',
      reason: null, createdAt: '2026-10-20T16:15:00Z', startedAt: '2026-10-20T16:15:00Z', endedAt: null, trackCount: 30, live: true,
      venues: ['Hyperliquid', 'Lighter'], markets: ['SOL'], timeframe: '1h',
      pnl: [{ venue: 'Hyperliquid', total: 0.12, percent: 0.12 }, { venue: 'Lighter', total: -0.05, percent: -0.05 }] } as PaperExperimentSummary;
    const html = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [run], onOpen: () => undefined }));
    expect(html).toContain('Total PnL');
    expect(html).toMatch(/Hyperliquid<\/span> <b[^>]*>\+0\.12 \(\+0\.12%\)/);
    expect(html).toMatch(/Lighter<\/span> <b[^>]*>−0\.05 \(−0\.05%\)/); // a true minus sign
  });
});
