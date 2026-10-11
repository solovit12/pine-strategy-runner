import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, paperModeLabel } from '../apps/web/src/App';
import { TradesTable } from '../apps/web/src/components/TradesTable';
import type { NormalizedTrade } from '../packages/shared/src/contracts';

describe('Binance backtester initial UI', () => {
  it('shows Paper in the header while it works, even with busy slots, and an engine that is off', () => {
    expect(paperModeLabel({ role: 'site', paper: { configured: true, acceptingNewRun: false } })).toBe('BACKTEST + PAPER');
    expect(paperModeLabel({ role: 'all', paper: { configured: true, acceptingNewRun: true } })).toBe('BACKTEST + PAPER');
    expect(paperModeLabel({ role: 'site', paper: { configured: false, acceptingNewRun: false } })).toBe('PAPER ENGINE OFF');
    expect(paperModeLabel({ role: 'all', paper: { configured: false, acceptingNewRun: false } })).toBe('BACKTEST ONLY');
  });

  it('keeps headings and field names English, and moves explanations to info icons', () => {
    const html = renderToStaticMarkup(createElement(App));
    const feeLabel = 'Commission per Fill, %';
    const feeField = html.slice(html.indexOf(feeLabel), html.indexOf('</label>', html.indexOf(feeLabel)));

    expect(html).toContain('Binance Futures');
    expect(html).toContain('<h2>Strategy Editor</h2>');
    expect(html).toContain('<span>Exchange</span>');
    expect(html).toContain('Strategy Properties');
    expect(html).not.toContain('Self-hosted execution layer');
    expect(html).not.toContain('role="tooltip" lang="ru">Биржа</span>');
    expect(html).not.toContain('role="tooltip" lang="ru">Настройки стратегии</span>');
    expect(feeField).toContain('value=""');
    expect(feeField).toContain('required=""');
    expect(feeField).not.toContain('0.045');
    expect(html).toContain('aria-label="Information about date range"');
    expect(html).toContain('aria-label="Information about backtest limitations"');
    expect(html).toContain('Binance Futures data');
    expect(html).toContain('Prices and execution may differ on Hyperliquid and Lighter');
    expect(html).not.toContain('0xArchive');
  });

  it('places a collapsed backtest explanation immediately after Broker Emulation and omits comparison UI', () => {
    const html = renderToStaticMarkup(createElement(App));
    const brokerIndex = html.indexOf('Broker Emulation');
    const explanationIndex = html.indexOf('How the Backtest Works');

    expect(brokerIndex).toBeGreaterThan(-1);
    expect(explanationIndex).toBeGreaterThan(brokerIndex);
    expect(html).toContain('<details class="backtest-explanation">');
    expect(html).not.toContain('<details class="backtest-explanation" open="">');
    expect(html).not.toContain('Нужна ручная сверка');
    expect(html).not.toContain('NO REFERENCE');
  });

  it('explains the deterministic same-minute stop/take rule without a day-limit message', () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('Both stop and take profit were touched in one minute');
    expect(html).toContain('Минутная свеча хранит только цены открытия');
    expect(html).toContain('the take profit wins');
    expect(html).not.toContain('69 days');
    expect(html).not.toContain('69 дней');
  });

  it('keeps date guidance in a keyboard-focusable bilingual info tooltip', () => {
    const html = renderToStaticMarkup(createElement(App));
    const dateLabel = html.slice(html.indexOf('To · UTC · inclusive'), html.indexOf('</label>', html.indexOf('To · UTC · inclusive')));

    expect(dateLabel).toContain('aria-label="Information about date range"');
    expect(dateLabel).toContain('tabindex="0"');
    expect(dateLabel).toContain('class="info-help-tooltip" role="tooltip"');
    expect(dateLabel).toContain('<span lang="en">Select a valid date range.</span>');
    expect(dateLabel).toContain('<span lang="ru">Выберите корректный период.</span>');
    expect(dateLabel).not.toContain('<small>');
  });

  it('shows at most 20 trades on a page while keeping the full trade count', () => {
    const trades: NormalizedTrade[] = Array.from({ length: 41 }, (_, index) => ({
      number: index + 1,
      side: 'long',
      entryTime: '2026-09-01T00:00:00.000Z',
      exitTime: '2026-09-01T01:00:00.000Z',
      entryPrice: 100,
      exitPrice: 101,
      size: 1,
      pnl: 1,
      pnlPercent: 1,
      commission: 0,
      durationBars: 1,
      entrySignal: 'Long',
      exitSignal: 'Close',
    }));
    const html = renderToStaticMarkup(createElement(TradesTable, { trades }));
    const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));

    expect((tbody.match(/<tr>/g) || []).length).toBe(20);
    expect(html).toContain('41 closed');
    expect(html).toContain('Page 1 of 3');
    expect(tbody).not.toContain('<td>21</td>');
  });

  it('shows trade sizes in the table locale without floating-point noise', () => {
    const html = renderToStaticMarkup(createElement(TradesTable, { trades: [{
      number: 1, side: 'long', entryTime: '2026-09-01T00:00:00.000Z', exitTime: '2026-09-01T01:00:00.000Z',
      entryPrice: 86.72, exitPrice: 85.36, size: 11.543316999999998, pnl: -16.69, pnlPercent: -1.67,
      commission: 0, durationBars: 1, entrySignal: 'Long', exitSignal: 'Short',
    }] }));
    expect(html).toContain('<td>11,543317</td>');
    expect(html).not.toContain('11.543316999999998');
  });
});
