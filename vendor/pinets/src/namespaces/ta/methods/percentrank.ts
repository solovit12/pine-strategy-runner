// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Percent Rank
 *
 * Returns the percentage of values in the last length previous bars that are less than or equal to the current value.
 */
export function percentrank(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const series = Series.from(source);

        if (context.idx < length) {
            return NaN;
        }

        const currentValue = series.get(0);
        if (isNaN(currentValue)) return NaN;

        let count = 0;
        let validValues = 0;

        for (let i = 1; i <= length; i++) {
            const val = series.get(i);

            if (isNaN(val)) continue;
            validValues++;

            if (val <= currentValue) {
                count++;
            }
        }

        if (validValues === 0) return NaN;

        return context.precision((count / validValues) * 100);
    };
}
