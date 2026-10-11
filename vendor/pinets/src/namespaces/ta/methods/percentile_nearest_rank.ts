// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Percentile Nearest Rank
 *
 * Calculates percentile using method of Nearest Rank.
 * A percentile calculated using the Nearest Rank method will always be a member of the input data set.
 */
export function percentile_nearest_rank(context: any) {
    return (source: any, _length: any, _percentage: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const percentage = Series.from(_percentage).get(0);
        const series = Series.from(source);

        if (context.idx < length - 1) {
            return NaN;
        }

        const values: number[] = [];
        for (let i = 0; i < length; i++) {
            const val = series.get(i);
            if (!isNaN(val)) {
                values.push(val);
            }
        }

        if (values.length === 0) return NaN;

        values.sort((a, b) => a - b);

        // Nearest Rank: index = ceil(P/100 * N) - 1
        let index = Math.ceil((percentage / 100) * values.length) - 1;

        if (index < 0) index = 0;
        if (index >= values.length) index = values.length - 1;

        return context.precision(values[index]);
    };
}

