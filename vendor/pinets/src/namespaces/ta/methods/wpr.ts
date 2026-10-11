// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Williams %R (WPR)
 *
 * The oscillator shows the current closing price in relation to the high and low
 * of the past 'length' bars.
 *
 * Formula:
 * %R = (Highest High - Close) / (Highest High - Lowest Low) * -100
 *
 * Note: Williams %R produces values between -100 and 0
 * - Values near -100 indicate oversold conditions
 * - Values near 0 indicate overbought conditions
 *
 * @param length - Number of bars (lookback period)
 * @returns Williams %R value (-100 to 0)
 */
export function wpr(context: any) {
    return (_length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `wpr_${length}`;

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

        // Get current values from context.data
        const high = context.get(context.data.high, 0);
        const low = context.get(context.data.low, 0);
        const close = context.get(context.data.close, 0);

        // Handle NaN inputs
        if (isNaN(high) || isNaN(low) || isNaN(close)) {
            // Propagate state
            state.currentHighWindow = [...state.prevHighWindow];
            state.currentLowWindow = [...state.prevLowWindow];
            return NaN;
        }

        const highWindow = [...state.prevHighWindow];
        const lowWindow = [...state.prevLowWindow];

        // Add to windows
        highWindow.unshift(high);
        lowWindow.unshift(low);

        if (highWindow.length > length) {
            highWindow.pop();
            lowWindow.pop();
        }

        state.currentHighWindow = highWindow;
        state.currentLowWindow = lowWindow;

        // Not enough data yet
        if (highWindow.length < length) {
            return NaN;
        }

        // Find highest high and lowest low in the window
        let highestHigh = highWindow[0];
        let lowestLow = lowWindow[0];

        for (let i = 1; i < length; i++) {
            if (highWindow[i] > highestHigh) {
                highestHigh = highWindow[i];
            }
            if (lowWindow[i] < lowestLow) {
                lowestLow = lowWindow[i];
            }
        }

        // Calculate Williams %R
        const range = highestHigh - lowestLow;

        if (range === 0) {
            return context.precision(0); // Avoid division by zero
        }

        // Williams %R formula: (Highest High - Close) / (Highest High - Lowest Low) * -100
        const wpr = ((highestHigh - close) / range) * -100;

        return context.precision(wpr);
    };
}
