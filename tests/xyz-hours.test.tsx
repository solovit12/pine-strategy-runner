import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { XyzHoursNotice } from '../apps/web/src/components/XyzHoursNotice';
import { isXyzMarket, usStockMarketState } from '../apps/web/src/lib/stock-hours';

describe('xyz markets outside stock exchange hours', () => {
  it('knows the regular US stock session in summer and winter time', () => {
    expect(usStockMarketState(Date.parse('2026-10-12T14:00:00Z'))).toBe('open'); // 10:00 New York (EDT)
    expect(usStockMarketState(Date.parse('2026-10-12T13:00:00Z'))).toBe('closed-hours'); // 9:00
    expect(usStockMarketState(Date.parse('2026-10-16T20:30:00Z'))).toBe('closed-hours'); // Friday 16:30
    expect(usStockMarketState(Date.parse('2026-12-14T14:00:00Z'))).toBe('closed-hours'); // 9:00 New York (EST)
    expect(usStockMarketState(Date.parse('2026-12-14T15:00:00Z'))).toBe('open');
    expect(usStockMarketState(Date.parse('2026-10-10T16:00:00Z'))).toBe('weekend'); // Saturday
    expect(usStockMarketState(Date.parse('2026-10-12T03:00:00Z'))).toBe('weekend'); // Sunday 23:00 New York
  });

  it('recognises xyz markets', () => {
    expect(['xyz:NVDA', 'BTC', 'xyz:GOLD'].filter(isXyzMarket)).toEqual(['xyz:NVDA', 'xyz:GOLD']);
  });

  it('warns on the setup screen whenever xyz markets are chosen, and on a run only while exchanges are closed', () => {
    const weekend = Date.parse('2026-10-10T16:00:00Z');
    const open = Date.parse('2026-10-12T14:00:00Z');
    const html = renderToStaticMarkup(createElement(XyzHoursNotice, { markets: ['xyz:NVDA', 'xyz:GOLD'], nowMs: weekend }));
    expect(html).toContain('xyz:NVDA, xyz:GOLD: stock and commodity markets');
    expect(html).toContain('Now: weekend, their home exchanges are closed.');
    expect(renderToStaticMarkup(createElement(XyzHoursNotice, { markets: ['xyz:NVDA'], nowMs: open }))).toContain('Now: US stock exchanges are open.');
    expect(renderToStaticMarkup(createElement(XyzHoursNotice, { markets: ['xyz:NVDA'], nowMs: open, onlyWhenClosed: true }))).toBe('');
    expect(renderToStaticMarkup(createElement(XyzHoursNotice, { markets: [], nowMs: weekend }))).toBe('');
  });
});
