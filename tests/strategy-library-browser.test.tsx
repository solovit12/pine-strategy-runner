import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyDetail, StrategySummary } from '../packages/shared/src/strategy-catalog-contracts';
import { StrategyLibraryBrowser, backtestFacts, filterStrategySummaries } from '../apps/web/src/components/StrategyLibraryBrowser';

const strategy = (id: string, name: string, currentVersion: number): StrategySummary => ({
  id, name, currentVersion, sourceSha256: 'a'.repeat(64),
  createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-25T11:33:00.000Z',
});

afterEach(() => vi.unstubAllGlobals());

describe('saved-strategy browser', () => {
  it('shows every saved strategy and a clear empty state', () => {
    const empty = renderToStaticMarkup(createElement(StrategyLibraryBrowser, {
      strategies: [], onLoadVersion: () => undefined,
    }));
    expect(empty).toContain('No saved strategies yet.');
    expect(empty).toContain('Saved strategies <span>(0)</span>');

    const populated = renderToStaticMarkup(createElement(StrategyLibraryBrowser, {
      strategies: [strategy('a', 'Range Levels', 3), strategy('b', 'Channel Breakout', 1)],
      onLoadVersion: () => undefined,
    }));
    expect(populated).toContain('Saved strategies <span>(2)</span>');
    expect(populated).toContain('Range Levels');
    expect(populated).toContain('Channel Breakout');
    expect(populated).toContain('Updated 2026-09-25 11:33 UTC');
    expect(populated).toContain('Search by name');
    expect(populated).toContain('aria-label="Information about saved strategies"');
    expect(populated).not.toContain('Pine SHA-256');
    expect(populated).not.toContain('Save New');
  });

  it('previews a preselected strategy without showing technical details before loading', () => {
    const markup = renderToStaticMarkup(createElement(StrategyLibraryBrowser, {
      strategies: [strategy('a', 'Range Levels', 3)],
      initialSelectedStrategyId: 'a',
      onLoadVersion: () => undefined,
    }));
    expect(markup).not.toContain('Select a strategy to preview it.');
    expect(markup).toContain('Loading strategy…');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('Pine SHA-256');
  });

  it('previews a Python strategy, which has no Pine backtest settings, without crashing', () => {
    expect(backtestFacts({})).toEqual({ market: 'No Pine backtest', dates: '—' });
    expect(backtestFacts({ symbol: 'HYPEUSDT', timeframe: '15m', dateRange: { start: '2026-09-08', end: '2026-10-07' } } as never))
      .toEqual({ market: 'HYPEUSDT · 15m', dates: '2026-09-08–2026-10-07' });
  });

  it('matches names case-insensitively and does not mutate the supplied list', () => {
    const items = [strategy('a', 'Range Levels', 2), strategy('b', 'Channel Breakout', 1)];
    expect(filterStrategySummaries(items, ' LEVELS ')).toEqual([items[0]]);
    expect(filterStrategySummaries(items, 'no result')).toEqual([]);
    expect(filterStrategySummaries(items, '')).toEqual(items);
    expect(items).toHaveLength(2);
  });
});
