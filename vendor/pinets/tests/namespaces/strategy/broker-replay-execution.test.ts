// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { describe, expect, it } from 'vitest';
import { PineTS, type StrategyBrokerTickAudit } from 'index';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

type Stage = 'open' | 'high' | 'low' | 'close';
type Point = { stage: Stage; price: number };

function parent(index: number, open = 100, high = 120, low = 80, close = 100) {
    return {
        openTime: T0 + index * HOUR,
        closeTime: T0 + (index + 1) * HOUR - 1,
        open,
        high,
        low,
        close,
        volume: 10,
    };
}

async function replay(source: string, paths: Record<number, Point[]>, bars = [parent(0), parent(1), parent(2)]) {
    const audits: StrategyBrokerTickAudit[] = [];
    const pine = new PineTS(bars, 'TEST', '60');
    pine.setStrategyBrokerReplayHook((controller) => {
        const points = paths[controller.parentBarIndex] ?? [];
        points.forEach((point, index) => {
            audits.push(controller.processTick({
                ...point,
                time: bars[controller.parentBarIndex].openTime + index,
                replayOpenTime: bars[controller.parentBarIndex].openTime,
                replaySequence: controller.parentBarIndex * 24 + index,
                priceTicks: Math.round(point.price * 100),
            }));
        });
    });
    const context = await pine.run(source);
    return { context, audits, events: audits.flatMap((audit) => audit.events) };
}

const declaration = (extra = '') =>
    `strategy("replay", overlay=false, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=1, margin_long=100, margin_short=100${extra})`;

describe('High replay market, limit and stop semantics', () => {
    it('replaces a pending strategy.entry with the same ID instead of filling its stale stop', async () => {
        const { context, events } = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long, stop=120)
if bar_index == 1
    strategy.entry("L", strategy.long, stop=130)
`, {
            1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 110 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'high', price: 125 }],
        });
        expect(events.filter((event) => event.eventType === 'fill')).toEqual([]);
        expect(context.strategy.position_size).toBe(0);
        expect(context.strategy.pending_orders.filter((order: any) => order.id === 'L')).toHaveLength(1);
        expect(context.strategy.pending_orders.find((order: any) => order.id === 'L')?.stop).toBe(130);
    });

    it('replaces a pending strategy.order with the same ID instead of filling its stale stop', async () => {
        const { context, events } = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.order("L", strategy.long, qty=1, stop=120)
if bar_index == 1
    strategy.order("L", strategy.long, qty=1, stop=130)
`, {
            1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 110 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'high', price: 125 }],
        });
        expect(events.filter((event) => event.eventType === 'fill')).toEqual([]);
        expect(context.strategy.position_size).toBe(0);
        expect(context.strategy.pending_orders.filter((order: any) => order.id === 'L')).toHaveLength(1);
        expect(context.strategy.pending_orders.find((order: any) => order.id === 'L')?.stop).toBe(130);
    });

    it('M01/M02/M03 fills long and short markets at the first eligible point with adverse slippage', async () => {
        const source = `
//@version=6
${declaration(', slippage=2')}
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short)
`;
        const { context, events } = await replay(source, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 110 }],
        });
        expect(events.filter((event) => event.eventType === 'fill').map((event) => [event.orderId, event.fillPrice])).toEqual([
            ['L', 100.02],
            ['S', 109.98],
        ]);
        expect(context.strategy.position_size).toBe(-1);
        expect(context.strategy.closedtrades).toHaveLength(1);
    });

    it('L01/L02/L03/L07 fills limit on cross/touch without slippage and improves a gap fill', async () => {
        const crossed = await replay(`
//@version=6
${declaration(', slippage=25')}
if bar_index == 0
    strategy.entry("L", strategy.long, limit=95)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'low', price: 95 }] });
        expect(crossed.context.strategy.opentrades[0].entry_price).toBe(95);
        expect(crossed.events.at(-1)?.reason).toBe('limit_cross');

        const gapped = await replay(`
//@version=6
${declaration(', slippage=25')}
if bar_index == 0
    strategy.entry("L", strategy.long, limit=95)
`, { 1: [{ stage: 'open', price: 90 }] });
        expect(gapped.context.strategy.opentrades[0].entry_price).toBe(90);
        expect(gapped.events.at(-1)?.reason).toBe('limit_gap_price_improvement');
    });

    it('L04/L05/L06 handles the mirrored short limit and keeps an un-crossed order pending', async () => {
        const filled = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("S", strategy.short, limit=105)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 106 }] });
        expect(filled.context.strategy.opentrades[0].entry_price).toBe(105);

        const gapped = await replay(`
//@version=6
${declaration(', slippage=25')}
if bar_index == 0
    strategy.entry("S", strategy.short, limit=105)
`, { 1: [{ stage: 'open', price: 110 }] });
        expect(gapped.context.strategy.opentrades[0].entry_price).toBe(110);

        const pending = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long, limit=90)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'low', price: 91 }] });
        expect(pending.context.strategy.pending_orders.map((order: any) => order.id)).toContain('L');
    });

    it('S01-S07 fills stops at the crossed level, uses the worse gap price, mirrors short, and applies slippage', async () => {
        const crossed = await replay(`
//@version=6
${declaration(', slippage=2')}
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 110 }] });
        expect(crossed.context.strategy.opentrades[0].entry_price).toBe(105.02);
        expect(crossed.events.at(-1)?.reason).toBe('stop_cross');

        const gapped = await replay(`
//@version=6
${declaration(', slippage=2')}
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105)
`, { 1: [{ stage: 'open', price: 110 }] });
        expect(gapped.context.strategy.opentrades[0].entry_price).toBe(110.02);
        expect(gapped.events.at(-1)?.reason).toBe('stop_gap_worse_price');

        const short = await replay(`
//@version=6
${declaration(', slippage=2')}
if bar_index == 0
    strategy.entry("S", strategy.short, stop=95)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'low', price: 90 }] });
        expect(short.context.strategy.opentrades[0].entry_price).toBe(94.98);

        const shortGap = await replay(`
//@version=6
${declaration(', slippage=2')}
if bar_index == 0
    strategy.entry("S", strategy.short, stop=95)
`, { 1: [{ stage: 'open', price: 90 }] });
        expect(shortGap.context.strategy.opentrades[0].entry_price).toBe(89.98);

        const touched = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105)
`, { 1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 105 }] });
        expect(touched.context.strategy.opentrades[0].entry_price).toBe(105);
    });
});

describe('High replay bracket and ordering semantics', () => {
    const bracketSource = (first: 'tp' | 'sl') => `
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.exit("TP", "L", limit=110)
    strategy.exit("SL", "L", stop=90)
plot(${first === 'tp' ? '1' : '2'})
`;

    it('B01/B02/B04/B05 executes TP before SL on O-H-L-C and cancels the sibling', async () => {
        const { context, events } = await replay(bracketSource('tp'), {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'high', price: 115 }, { stage: 'low', price: 85 }, { stage: 'close', price: 95 }],
        });
        expect(context.strategy.closedtrades[0].exit_price).toBe(110);
        expect(events.filter((event) => event.parentBarIndex === 2).map((event) => [event.eventType, event.orderId])).toEqual([
            ['fill', 'TP'],
            ['cancel', 'SL'],
        ]);
    });

    it('B01/B03/B04/B05 executes SL before TP on O-L-H-C and cancels the sibling', async () => {
        const { context, events } = await replay(bracketSource('sl'), {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'low', price: 85 }, { stage: 'high', price: 115 }, { stage: 'close', price: 95 }],
        });
        expect(context.strategy.closedtrades[0].exit_price).toBe(90);
        expect(events.filter((event) => event.parentBarIndex === 2).map((event) => [event.eventType, event.orderId])).toEqual([
            ['fill', 'SL'],
            ['cancel', 'TP'],
        ]);
    });

    it('B06/B08 orders multiple crossed exit levels along the segment and closes each source lot once', async () => {
        const source = `
//@version=6
strategy("multi", overlay=false, initial_capital=100000, pyramiding=2, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("A", strategy.long)
    strategy.entry("B", strategy.long)
if bar_index == 1
    strategy.exit("EA", "A", limit=105)
    strategy.exit("EB", "B", limit=110)
`;
        const { context, events } = await replay(source, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'high', price: 115 }],
        });
        expect(events.filter((event) => event.parentBarIndex === 2 && event.eventType === 'fill').map((event) => event.orderId)).toEqual(['EA', 'EB']);
        expect(context.strategy.closedtrades.map((trade: any) => trade.exit_price)).toEqual([105, 110]);
        expect(context.strategy.position_size).toBe(0);
    });

    it('B08 gives an exit priority over an entry at the same crossed level', async () => {
        const source = `
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.exit("EXIT", "L", limit=105)
    strategy.order("SHORT", strategy.short, qty=1, limit=105)
`;
        const { context, events } = await replay(source, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'high', price: 110 }],
        });
        expect(events.filter((event) => event.parentBarIndex === 2 && event.eventType === 'fill').map((event) => event.orderId)).toEqual(['EXIT', 'SHORT']);
        expect(context.strategy.position_size).toBe(-1);
    });

    it('B07 orders falling exit levels from the higher trigger to the lower trigger', async () => {
        const source = `
//@version=6
strategy("multi down", overlay=false, initial_capital=100000, pyramiding=2, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("A", strategy.short)
    strategy.entry("B", strategy.short)
if bar_index == 1
    strategy.exit("EA", "A", limit=95)
    strategy.exit("EB", "B", limit=90)
`;
        const { context, events } = await replay(source, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }, { stage: 'low', price: 85 }],
        });
        expect(events.filter((event) => event.parentBarIndex === 2 && event.eventType === 'fill').map((event) => event.orderId)).toEqual(['EA', 'EB']);
        expect(context.strategy.closedtrades.map((trade: any) => trade.exit_price)).toEqual([95, 90]);
    });

    it('B09 keeps call order for two entries at the same trigger price', async () => {
        const source = `
//@version=6
strategy("same level", overlay=false, initial_capital=100000, pyramiding=2, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("FIRST", strategy.long, stop=105)
    strategy.entry("SECOND", strategy.long, stop=105)
`;
        const { events } = await replay(source, {
            1: [{ stage: 'open', price: 100 }, { stage: 'high', price: 110 }],
        });
        expect(events.filter((event) => event.eventType === 'fill').map((event) => event.orderId)).toEqual(['FIRST', 'SECOND']);
    });
});

describe('High replay accounting', () => {
    it('A01/A02 sizes fixed and cash orders at the actual fill price', async () => {
        const fixed = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long)
`, { 1: [{ stage: 'open', price: 125 }] });
        expect(fixed.context.strategy.position_size).toBe(1);

        const cash = await replay(`
//@version=6
strategy("cash", overlay=false, initial_capital=100000, default_qty_type=strategy.cash, default_qty_value=1000)
if bar_index == 0
    strategy.entry("L", strategy.long)
`, { 1: [{ stage: 'open', price: 125 }] });
        expect(cash.context.strategy.position_size).toBe(8);
    });

    it('A03 sizes percent-of-equity from pre-fill equity and actual fill', async () => {
        const { context } = await replay(`
//@version=6
strategy("percent", overlay=false, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=10)
if bar_index == 0
    strategy.entry("L", strategy.long)
`, { 1: [{ stage: 'open', price: 125 }] });
        expect(context.strategy.position_size).toBe(80);
    });

    it('A04/A06/A07/A08/A09 performs an atomic reversal and keeps fees, realized/open PnL and equity consistent', async () => {
        const { context } = await replay(`
//@version=6
${declaration(', commission_type=strategy.commission.percent, commission_value=1')}
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short)
        `, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 110 }, { stage: 'close', price: 105 }],
        }, [parent(0), parent(1), parent(2, 110, 110, 105, 105)]);
        expect(context.strategy.position_size).toBe(-1);
        expect(context.strategy.closedtrades).toHaveLength(1);
        expect(context.strategy.closedtrades[0].profit).toBeCloseTo(7.9);
        expect(context.strategy.netprofit).toBeCloseTo(6.8);
        expect(context.strategy.openprofit).toBeCloseTo(5);
        expect(context.strategy.equity).toBeCloseTo(100011.8);
    });

    it('A07 charges cash-per-contract commission on both filled legs', async () => {
        const { context } = await replay(`
//@version=6
strategy("contract fees", overlay=false, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=2, commission_type=strategy.commission.cash_per_contract, commission_value=3)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L")
`, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 110 }],
        });
        expect(context.strategy.closedtrades[0].commission).toBe(12);
        expect(context.strategy.closedtrades[0].profit).toBe(8);
        expect(context.strategy.netprofit).toBe(8);
    });

    it('A08 charges one cash-per-order fee for an atomic reversal order', async () => {
        const { context } = await replay(`
//@version=6
strategy("order fees", overlay=false, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.cash_per_order, commission_value=5)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short)
`, {
            1: [{ stage: 'open', price: 100 }],
            2: [{ stage: 'open', price: 100 }],
        });
        expect(context.strategy.closedtrades[0].commission).toBe(7.5);
        expect(context.strategy.opentrades[0].commission).toBe(2.5);
        expect(context.strategy.netprofit).toBe(-10);
    });

    it('A09 marks open PnL only at replay prices already reached', async () => {
        const { audits } = await replay(`
//@version=6
${declaration()}
if bar_index == 0
    strategy.entry("L", strategy.long)
`, {
            1: [
                { stage: 'open', price: 100 },
                { stage: 'high', price: 105 },
                { stage: 'low', price: 95 },
            ],
        });
        expect(audits.filter((audit) => audit.parentBarIndex === 1).map((audit) => audit.openProfitAfter)).toEqual([0, 5, -5]);
    });

    it('A05/A10 preserves pyramiding and produces deterministic replay audit coordinates', async () => {
        const source = `
//@version=6
strategy("pyramid", overlay=false, initial_capital=100000, pyramiding=2, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("A", strategy.long)
    strategy.entry("B", strategy.long)
`;
        const first = await replay(source, { 1: [{ stage: 'open', price: 100 }] });
        const second = await replay(source, { 1: [{ stage: 'open', price: 100 }] });
        expect(first.context.strategy.position_size).toBe(2);
        expect(first.events).toEqual(second.events);
        expect(first.events[0]).toMatchObject({ parentBarIndex: 1, replaySequence: 24, replayOpenTime: T0 + HOUR, stage: 'open' });
    });
});
