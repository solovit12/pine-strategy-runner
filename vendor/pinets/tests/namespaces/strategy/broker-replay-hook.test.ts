// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { describe, expect, it } from 'vitest';

import { PineTS, type StrategyBrokerTickAudit } from 'index';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const bars = [
    { openTime: T0, closeTime: T0 + HOUR, open: 100, high: 104, low: 99, close: 103, volume: 10 },
    { openTime: T0 + HOUR, closeTime: T0 + 2 * HOUR, open: 110, high: 112, low: 101, close: 108, volume: 11 },
];

const source = `
//@version=6
strategy("H0 broker replay", overlay=false, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=2, commission_type=strategy.commission.percent, commission_value=1)
var int executions = 0
executions += 1
if bar_index == 0
    strategy.entry("Long", strategy.long)
plot(executions, "executions")
`;

describe('Strategy broker replay hook', () => {
    it('fills an existing order on an external tick through the same ledger without re-running Pine', async () => {
        const audits: StrategyBrokerTickAudit[] = [];
        const observedPendingOrderIds: readonly string[][] = [];
        const observedPendingOrders: unknown[] = [];
        const pineTS = new PineTS(bars, 'TEST', '60');

        pineTS.setStrategyBrokerReplayHook((controller) => {
            observedPendingOrderIds.push(controller.pendingOrderIds);
            observedPendingOrders.push(controller.pendingOrders);
            audits.push(
                controller.processTick({
                    price: 105,
                    time: T0 + HOUR + 60_000,
                    label: 'external-1m-open',
                }),
            );
        });

        const context = await pineTS.run(source);
        const executions = context.plots.executions.data.map((point: { value: number }) => point.value);

        expect(executions).toEqual([1, 2]);
        expect(audits).toEqual([
            {
                parentBarIndex: 1,
                sequence: 1,
                price: 105,
                time: T0 + HOUR + 60_000,
                label: 'external-1m-open',
                filledOrderIds: ['Long'],
                cancelledOrderIds: [],
                positionSizeBefore: 0,
                positionSizeAfter: 2,
                openTradesBefore: 0,
                openTradesAfter: 1,
                closedTradesBefore: 0,
                closedTradesAfter: 0,
                equityBeforeFills: 10000,
                requiredMarginBeforeFills: 0,
                marginCallRequiredBeforeFills: false,
                netProfitAfter: -2.1,
                openProfitAfter: 0,
                equityAfter: 9997.9,
                requiredMarginAfter: 210,
                marginCallRequiredAfter: false,
                events: [
                    {
                        eventType: 'fill',
                        orderId: 'Long',
                        category: 'entry',
                        parentBarIndex: 1,
                        replaySequence: 1,
                        replayOpenTime: T0 + HOUR + 60_000,
                        stage: 'external',
                        priceAfterTicks: 10500,
                        triggerPriceTicks: 10500,
                        fillPriceTicks: 10500,
                        triggerPrice: 105,
                        fillPrice: 105,
                        reason: 'market_first_eligible_tick',
                    },
                ],
            },
        ]);
        expect(observedPendingOrderIds).toEqual([['Long']]);
        expect(observedPendingOrders).toEqual([[{
            id: 'Long',
            type: 'market',
            category: 'entry',
            qty: 2,
            hasTrailingParameters: false,
            hasOcaParameters: false,
            hasImmediateExecution: false,
        }]]);
        expect(context.strategy.position_size).toBe(2);
        expect(context.strategy.opentrades).toHaveLength(1);
        expect(context.strategy.opentrades[0].entry_price).toBe(105);
        expect(context.strategy.opentrades[0].commission).toBeCloseTo(2.1);
        expect(context.strategy.pending_orders).toHaveLength(0);
    });

    it('preserves the existing parent-bar execution path when no hook is installed', async () => {
        const pineTS = new PineTS(bars, 'TEST', '60');
        const context = await pineTS.run(source);
        const executions = context.plots.executions.data.map((point: { value: number }) => point.value);

        expect(executions).toEqual([1, 2]);
        expect(context.strategy.position_size).toBe(2);
        expect(context.strategy.opentrades).toHaveLength(1);
        expect(context.strategy.opentrades[0].entry_price).toBe(110);
        expect(context.strategy.opentrades[0].commission).toBeCloseTo(2.2);
        expect(context.strategy.pending_orders).toHaveLength(0);
    });

    it('rejects non-monotonic external tick times and restores parent OHLC', async () => {
        const pineTS = new PineTS(bars, 'TEST', '60');
        pineTS.setStrategyBrokerReplayHook((controller) => {
            controller.processTick({ price: 105, time: T0 + HOUR + 120_000 });
            expect(() => controller.processTick({ price: 106, time: T0 + HOUR + 60_000 })).toThrow(/strictly increasing/);
        });

        const context = await pineTS.run(source);
        expect(context.data.open.get(0)).toBe(110);
        expect(context.data.high.get(0)).toBe(112);
        expect(context.data.low.get(0)).toBe(101);
        expect(context.data.close.get(0)).toBe(108);
    });

    it('rejects ticks outside the current parent bar', async () => {
        const pineTS = new PineTS(bars, 'TEST', '60');
        pineTS.setStrategyBrokerReplayHook((controller) => {
            expect(() => controller.processTick({ price: 105, time: T0 + 2 * HOUR + 1 })).toThrow(/inside the current parent bar/);
        });

        const context = await pineTS.run(source);
        expect(context.strategy.position_size).toBe(0);
        expect(context.strategy.pending_orders).toHaveLength(1);
    });
});
