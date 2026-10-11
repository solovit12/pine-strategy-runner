// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Money Flow Index (MFI)
 *
 * MFI is a momentum indicator that uses price and volume to identify overbought or oversold conditions.
 *
 * Pine Script Formula:
 * upper = sum(volume * (change(src) <= 0 ? 0 : src), length)
 * lower = sum(volume * (change(src) >= 0 ? 0 : src), length)
 * mfi = 100.0 - (100.0 / (1.0 + upper / lower))
 *
 * @param source - Source series (typically hlc3)
 * @param length - Number of bars back (lookback period)
 * @returns MFI value (0-100)
 */
export function mfi(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `mfi_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevUpperWindow: [],
                prevLowerWindow: [],
                prevUpperSum: 0,
                prevLowerSum: 0,
                // Tentative state
                currentUpperWindow: [],
                currentLowerWindow: [],
                currentUpperSum: 0,
                currentLowerSum: 0,
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevUpperWindow = [...state.currentUpperWindow];
                state.prevLowerWindow = [...state.currentLowerWindow];
                state.prevUpperSum = state.currentUpperSum;
                state.prevLowerSum = state.currentLowerSum;
            }
            state.lastIdx = context.idx;
        }

        // Get current values
        const currentSrc = Series.from(source).get(0);
        const previousSrc = Series.from(source).get(1);
        const volume = context.get(context.data.volume, 0);

        // Handle NaN inputs
        if (isNaN(currentSrc) || isNaN(volume)) {
            // Can't update properly, return NaN but maintain window?
            // If we skip update, sum lags.
            // Assuming NaN src means no flow.
            return NaN;
        }

        // Calculate change
        const change = isNaN(previousSrc) ? NaN : currentSrc - previousSrc;

        // Calculate components
        // upper: if change <= 0, use 0, else use src
        const upperComponent = volume * (change <= 0 ? 0 : currentSrc);
        // lower: if change >= 0, use 0, else use src
        const lowerComponent = volume * (change >= 0 ? 0 : currentSrc);

        // Use committed state
        const upperWindow = [...state.prevUpperWindow];
        const lowerWindow = [...state.prevLowerWindow];
        let upperSum = state.prevUpperSum;
        let lowerSum = state.prevLowerSum;

        // Add to windows
        upperWindow.unshift(upperComponent);
        lowerWindow.unshift(lowerComponent);
        upperSum += upperComponent;
        lowerSum += lowerComponent;

        // Not enough data yet
        if (upperWindow.length < length) {
            state.currentUpperWindow = upperWindow;
            state.currentLowerWindow = lowerWindow;
            state.currentUpperSum = upperSum;
            state.currentLowerSum = lowerSum;
            return NaN;
        }

        // Remove oldest values if window exceeds length
        if (upperWindow.length > length) {
            const oldUpper = upperWindow.pop();
            const oldLower = lowerWindow.pop();
            upperSum -= oldUpper;
            lowerSum -= oldLower;
        }

        // Update tentative state
        state.currentUpperWindow = upperWindow;
        state.currentLowerWindow = lowerWindow;
        state.currentUpperSum = upperSum;
        state.currentLowerSum = lowerSum;

        // Calculate MFI
        if (lowerSum === 0) {
            if (upperSum === 0) {
                return context.precision(100); 
            }
            return context.precision(100); 
        }

        if (upperSum === 0) {
            return context.precision(0); 
        }

        const mfi = 100.0 - 100.0 / (1.0 + upperSum / lowerSum);

        return context.precision(mfi);
    };
}
