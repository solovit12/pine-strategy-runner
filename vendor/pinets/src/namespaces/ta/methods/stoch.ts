// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Stochastic Oscillator (STOCH)
 *
 * The Stochastic Oscillator is a momentum indicator that shows the location of the close
 * relative to the high-low range over a set number of periods.
 *
 * Formula:
 * STOCH = 100 * (close - lowest(low, length)) / (highest(high, length) - lowest(low, length))
 *
 * @param source - Source series (typically close price)
 * @param high - Series of high prices
 * @param low - Series of low prices
 * @param length - Number of bars back (lookback period)
 * @returns Stochastic value (0-100)
 *
 * @remarks
 * - NaN values in the source series are ignored
 * - Returns NaN during initialization period (when not enough data)
 * - Returns NaN if highest equals lowest (to avoid division by zero)
 */
export function stoch(context: any) {
    return (source: any, high: any, low: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);

        // Use incremental calculation with rolling windows for highest/lowest
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `stoch_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevHighWindow: [],
                prevLowWindow: [],
                // Tentative state
                currentHighWindow: [],
                currentLowWindow: [],
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevHighWindow = [...state.currentHighWindow];
                state.prevLowWindow = [...state.currentLowWindow];
            }
            state.lastIdx = context.idx;
        }
        
        // Get current values
        const currentSource = Series.from(source).get(0);
        const currentHigh = Series.from(high).get(0);
        const currentLow = Series.from(low).get(0);

        // Handle NaN inputs - skip this bar
        if (isNaN(currentSource) || isNaN(currentHigh) || isNaN(currentLow)) {
            // Propagate state
            state.currentHighWindow = [...state.prevHighWindow];
            state.currentLowWindow = [...state.prevLowWindow];
            return NaN;
        }

        const highWindow = [...state.prevHighWindow];
        const lowWindow = [...state.prevLowWindow];

        // Add current values to windows
        highWindow.unshift(currentHigh);
        lowWindow.unshift(currentLow);

        // Remove oldest values if window exceeds length
        if (highWindow.length > length) {
            highWindow.pop();
            lowWindow.pop();
        }
        
        // Update tentative state
        state.currentHighWindow = highWindow;
        state.currentLowWindow = lowWindow;

        // Not enough data yet
        if (highWindow.length < length) {
            return NaN;
        }

        // Calculate highest high and lowest low over the period
        let highest = highWindow[0];
        let lowest = lowWindow[0];

        for (let i = 1; i < length; i++) {
            if (highWindow[i] > highest) {
                highest = highWindow[i];
            }
            if (lowWindow[i] < lowest) {
                lowest = lowWindow[i];
            }
        }

        // Calculate stochastic
        const range = highest - lowest;
        
        // Avoid division by zero
        if (range === 0) {
            return NaN;
        }

        const stochastic = 100 * (currentSource - lowest) / range;

        return context.precision(stochastic);
    };
}
