import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaperPositionsTable, PaperRunActivity, PaperRunDataGaps, PaperRunHealth, PaperRunRules, PaperRunHistory, PaperRunTrackTable, PaperRuns } from '../apps/web/src/components/PaperRuns';
import type { PaperExperimentActivity, PaperExperimentSummary, PaperExperimentDetail } from '../packages/shared/src/paper-experiment-contracts';

const sample: PaperExperimentSummary = {
  id: 'run-1', strategyId: 'strategy-1', strategyName: 'Range Levels', strategyVersion: 2,
  sourceSha256: 'a'.repeat(64), status: 'stopping',
  reason: 'Paper runtime stop failed: hyperliquid input ACK: Same-millisecond market event',
  createdAt: '2026-09-29T07:59:00.000Z', startedAt: '2026-09-29T08:00:00.000Z',
  endedAt: '2026-09-29T09:15:00.000Z', trackCount: 2,
  venues: ['Hyperliquid', 'Lighter'], markets: ['HYPE'], timeframe: '1h',
  capitalPerVenue: 5_000,
};

afterEach(() => vi.unstubAllGlobals());

describe('Paper run history', () => {
  it('shows a data gap as a running run state, not as an alarm', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, status: 'recovering', reason: null, endedAt: null }], onOpen: () => undefined,
    }));
    expect(html).toContain('<strong>Running · data gap</strong>');
    expect(html).not.toContain('Interrupted');
  });

  it('lists only the markets without fresh data and tags their open positions', () => {
    const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
    const detail = {
      status: 'running',
      accounts: [{ venue: 'Lighter', accountId: 'lighter', startingCash: 1000 }],
      runtime: { stage: 'running', engine: 'nautilus',
        accounts: [{ venue: 'Lighter', accountId: 'lighter', cashBalance: '1000', positions: [
          { market: 'QQQ', side: 'long', quantity: '1', avgEntryPrice: '500', markPrice: '501', unrealizedPnl: '1' },
          { market: 'BTC', side: 'short', quantity: '0.01', avgEntryPrice: '60000', markPrice: '60000', unrealizedPnl: '0' },
        ] }],
        tracks: [
          { venue: 'Lighter', market: 'QQQ', priceReady: false, pendingOrders: 0,
            dataGap: { sinceMs: nowMs - 12 * 60_000, connected: true, resubscribes: 2 } },
          { venue: 'Lighter', market: 'BTC', priceReady: true, pendingOrders: 0 },
        ] },
    } as unknown as PaperExperimentDetail;
    const notice = renderToStaticMarkup(createElement(PaperRunDataGaps, { detail, nowMs }));
    expect(notice).toContain('No fresh market data · 1 market');
    expect(notice).toContain('<b>Lighter QQQ</b> — 12 min without data · connection restored; order book requested again 2 times · open position: its exits wait for data');
    expect(notice).not.toContain('BTC');
    const table = renderToStaticMarkup(createElement(PaperPositionsTable, { detail }));
    expect(table.match(/paper-gap-tag/g)).toHaveLength(1);
    expect(table.split('paper-gap-tag')[0]).toContain('QQQ');
    expect(renderToStaticMarkup(createElement(PaperRunDataGaps, { detail: { ...detail, status: 'completed' }, nowMs }))).toBe('');
  });

  it('shows individual readiness on a shared account and never copies its ready flag across missing market rows', () => {
    const detail = {
      tracks: ['HYPE', 'SOL'].map((market, index) => ({ venue: 'Lighter', market, trackId: market,
        accountId: 'shared-lighter', runId: 'same-run', status: 'running', updatedAt: sample.createdAt,
        events: index + 11, signals: index + 21, intents: index + 31, fills: index + 41 })),
      runtime: { stage: 'running', engine: 'nautilus', accounts: [{ venue: 'Lighter', accountId: 'shared-lighter',
        runId: 'same-run', priceReady: true, pendingOrders: 99 }], tracks: [
        { venue: 'Lighter', market: 'HYPE', priceReady: true, pendingOrders: 0 },
        { venue: 'Lighter', market: 'SOL', priceReady: false, pendingOrders: 1 },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperRunTrackTable, { detail }));
    const rows = html.split('<tbody>')[1]!.split('</tbody>')[0]!.split('</tr>');
    expect(rows[0]).toContain('<td>HYPE</td>');
    expect(rows[0]).toContain('<td>Ready</td><td>0</td>');
    expect(rows[1]).toContain('<td>SOL</td>');
    expect(rows[1]).toContain('<td>Waiting for fresh price</td><td>1</td>');
    expect(html).not.toContain('<td>99</td>');
    const missing = renderToStaticMarkup(createElement(PaperRunTrackTable, { detail: {
      ...detail, runtime: { ...detail.runtime!, tracks: undefined },
    } }));
    expect(missing.match(/Not reported/g)).toHaveLength(2);
    expect(missing).not.toContain('<td>Ready</td>');
  });

  it('shows launch characteristics and a short status instead of the technical stop reason', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [sample], onOpen: () => undefined,
    }));

    expect(html).toContain('Hyperliquid, Lighter');
    expect(html).toContain('HYPE');
    expect(html).toContain('1h');
    expect(html).toContain('5,000 USDC');
    expect(html).toContain('1h 15m');
    expect(html).toContain('Stop needs attention');
    expect(html).not.toContain('Same-millisecond market event');
    expect(html).not.toContain('Paper runtime stop failed');
  });

  it('does not put the history table on a specific run page', () => {
    vi.stubGlobal('window', { location: { pathname: '/paper/run-1' } });
    const html = renderToStaticMarkup(createElement(PaperRuns, { onPrepare: () => undefined }));

    expect(html).toContain('All runs');
    expect(html).not.toContain('Server experiments');
  });
});

describe('Paper run activity', () => {
  const activity: PaperExperimentActivity = {
    eventCoverage: 'key_milestones', coverage: 'durable_journal', totalFills: 2, nextFillsCursor: null,
    events: [
      { id: 'event-2', at: '2026-09-29T08:00:00.000Z', kind: 'status', venue: 'Lighter', market: 'HYPE', message: 'Paper was interrupted.' },
      { id: 'event-1', at: '2026-09-29T07:00:00.000Z', kind: 'started', message: 'Paper started.' },
    ],
    fills: [
      { id: 'fill-2', at: '2026-09-29T07:59:00.000Z', venue: 'Lighter', market: 'HYPE', kind: 'exit', side: 'sell', positionSide: 'long', quantity: '2', quote: '100', price: '50', fee: '0', realizedPnl: '1.23' },
      { id: 'fill-1', at: null, venue: 'Hyperliquid', market: 'HYPE', kind: 'entry', side: 'buy', positionSide: 'long', quantity: '2', quote: '99', price: null, fee: null, realizedPnl: null },
    ],
  };

  it('shows supplied realized PnL and leaves missing fill values unknown', () => {
    const html = renderToStaticMarkup(createElement(PaperRunActivity, {
      activity, loading: false, refreshFailed: false, pageIndex: 0,
      onPrevious: () => undefined, onNext: () => undefined,
    }));

    expect(html).toContain('Paper was interrupted.');
    expect(html).toContain('Paper started.');
    expect(html).toContain('2 committed virtual fills');
    expect(html).toContain('Hyperliquid');
    expect(html).toContain('Lighter');
    expect(html).toContain('99 USDC');
    expect(html).toContain('Realized PnL</th>');
    expect(html).toContain('1.23 USDC');
    expect(html).toContain('Realized PnL is shown only when the execution engine supplies it');
    expect(html).toContain('Реализованный PnL показан только там, где движок передал его');
    expect(html).not.toContain('null USDC');
  });

  it('marks incomplete journal coverage and offers access to the next fill page', () => {
    const html = renderToStaticMarkup(createElement(PaperRunActivity, {
      activity: { ...activity, coverage: 'partial', totalFills: null, nextFillsCursor: 'opaque-next' },
      loading: false, refreshFailed: false, pageIndex: 0,
      onPrevious: () => undefined, onNext: () => undefined,
    }));

    expect(html).toContain('Some journal history is unavailable');
    expect(html).toContain('Next');
    expect(html).not.toContain('2 committed virtual fills');
  });

  it('shows only the latest five events until expanded', () => {
    const many = { ...activity, events: Array.from({ length: 8 }, (_, index) => ({
      id: `e${index}`, at: '2026-09-29T08:00:00.000Z', kind: 'status', message: `event number ${index}` })) } as unknown as PaperExperimentActivity;
    const props = { activity: many, loading: false, refreshFailed: false, pageIndex: 0, onPrevious: () => undefined, onNext: () => undefined };
    const collapsed = renderToStaticMarkup(createElement(PaperRunActivity, props));
    expect(collapsed).toContain('event number 4');
    expect(collapsed).not.toContain('event number 5');
    expect(collapsed).toContain('Show all 8 events');
    const expanded = renderToStaticMarkup(createElement(PaperRunActivity, { ...props, initiallyExpanded: true }));
    expect(expanded).toContain('event number 7');
    expect(expanded).toContain('Show the latest 5 only');
  });

  it('lists open positions by exchange with side colour, UPNL, leverage and exchange PnL', () => {
    const detail = {
      accounts: [
        { venue: 'Lighter', accountId: 'acc-l', runId: 'r', startingCash: 10_000, currency: 'USDC' },
        { venue: 'Hyperliquid', accountId: 'acc-h', runId: 'r', startingCash: 10_000, currency: 'USDC' },
      ],
      runtime: { stage: 'running', engine: 'nautilus', observedAt: '2026-10-07T10:00:00.000Z', fundingTreatment: 'excluded', accounts: [
        { venue: 'Lighter', accountId: 'acc-l', runId: 'r', cashBalance: '10012.5', positions: [
          { market: 'HYPE', side: 'long', remainingBaseQuantity: '10', avgEntryPrice: '89.04', markPrice: '90', unrealizedPnl: '9.6', openedAt: '2026-10-07T09:50:00.000Z' },
          { market: 'SOL', side: 'short', remainingBaseQuantity: '2', avgEntryPrice: '118.25', markPrice: '119', unrealizedPnl: '-1.5' },
        ] },
        { venue: 'Hyperliquid', accountId: 'acc-h', runId: 'r', cashBalance: '9990', positions: [] },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperPositionsTable, { detail }));
    expect(html).toContain('<strong class="paper-side-long" title="Long">HYPE</strong>');
    expect(html).toContain('<strong class="paper-side-short" title="Short">SOL</strong>');
    expect(html).toContain('+9.60 USDC');
    expect(html).toContain('−1.50 USDC');
    expect(html).toContain('0.09x'); // 10 × 90 / (10012.5 + 8.1)
    expect(html).toContain('Total PnL <b class="paper-pnl-up">+20.60 (+0.21%)</b>');
    expect(html).toContain('Total PnL <b class="paper-pnl-down">−10.00 (−0.10%)</b>');
    expect(html).toContain('No open positions');
    expect(html).not.toContain('Diff');
  });

  it('states the markets, balances, fees, parameters and execution rules of the run', () => {
    const detail = {
      status: 'running',
      tracks: [
        { venue: 'Lighter', market: 'HYPE' }, { venue: 'Lighter', market: 'SOL' }, { venue: 'Hyperliquid', market: 'HYPE' },
      ],
      settings: { accountModel: 'python_live_v1', timeframe: '1h', capitalPerVenue: 10_000, orderSizePercent: 10,
        lighterMakerFeePercent: 0, lighterTakerFeePercent: 0, hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045,
        params: { volatile_markets: 'HYPE,SOL', take_profit_percent: 1.2 } },
      runtime: { tracks: [
        { venue: 'Lighter', market: 'HYPE', priceReady: true, pendingOrders: 1 },
        { venue: 'Lighter', market: 'SOL', priceReady: false, pendingOrders: 0 },
        { venue: 'Hyperliquid', market: 'HYPE', priceReady: true, pendingOrders: 0 },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperRunRules, { detail }));
    expect(html).toContain('<td>HYPE, SOL</td>');
    expect(html).toContain('<td>0.015%</td><td>0.045%</td>');
    expect(html).toContain('10,000 USDC');
    expect(html).toContain('10% of the exchange balance per entry');
    expect(html).toContain('volatile_markets = HYPE,SOL · take_profit_percent = 1.2');
    expect(html).toContain('taker fee is charged on every fill');
    const health = renderToStaticMarkup(createElement(PaperRunHealth, { detail }));
    expect(health).toContain('2 of 3 markets — waiting: Lighter SOL');
    expect(health).toContain('<span>Working orders</span><strong>1</strong>');
  });
});
