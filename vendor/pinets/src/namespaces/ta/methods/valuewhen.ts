// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Value When
 *
 * Returns the value of the source series on the bar where the condition was true on the nth most recent occurrence.
 */
export function valuewhen(context: any) {
    return (condition: any, source: any, _occurrence: any, _callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'valuewhen';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevValues: [],
                // Tentative state
                currentValues: [],
            };
        }
        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevValues = [...state.currentValues];
            }
            state.lastIdx = context.idx;
        }

        const cond = Series.from(condition).get(0);
        const val = Series.from(source).get(0);
        const occurrence = Series.from(_occurrence).get(0);

        // Use committed values as base
        const values = [...state.prevValues];

        if (cond) {
            values.push(val);
        }

        // Update tentative state
        state.currentValues = values;

        if (isNaN(occurrence) || occurrence < 0) {
            return NaN;
        }

        const index = values.length - 1 - occurrence;

        if (index < 0) {
            return NaN;
        }

        const result = values[index];

        // Check if result is a number to apply precision, else return as is (e.g. boolean/color)
        if (typeof result === 'number') {
            return context.precision(result);
        }
        return result;
    };
}
