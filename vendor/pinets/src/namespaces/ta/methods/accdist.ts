// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Accumulation/Distribution (AccDist)
 *
 * Formula:
 * AD = cum(((close - low) - (high - close)) / (high - low) * volume)
 */
export function accdist(context: any) {
    return (_callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'accdist';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevCumulativeSum: 0,
                // Tentative state
                currentCumulativeSum: 0,
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevCumulativeSum = state.currentCumulativeSum;
            }
            state.lastIdx = context.idx;
        }

        const close = context.get(context.data.close, 0);
        const high = context.get(context.data.high, 0);
        const low = context.get(context.data.low, 0);
        const volume = context.get(context.data.volume, 0);

        if (isNaN(close) || isNaN(high) || isNaN(low) || isNaN(volume)) {
            state.currentCumulativeSum = state.prevCumulativeSum;
            return context.precision(state.prevCumulativeSum);
        }

        const range = high - low;
        let term = 0;

        if (range !== 0) {
            term = ((close - low) - (high - close)) / range * volume;
        }

        const currentSum = state.prevCumulativeSum + term;
        state.currentCumulativeSum = currentSum;

        return context.precision(currentSum);
    };
}

