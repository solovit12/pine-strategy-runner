// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Percentile Linear Interpolation
 *
 * Calculates percentile using method of linear interpolation between the two nearest ranks.
 */
export function percentile_linear_interpolation(context: any) {
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
            if (isNaN(val)) return NaN;
            values.push(val);
        }

        values.sort((a, b) => a - b);

        // Formula inferred from test data: index = (percentage / 100) * length - 0.5
        let index = (percentage / 100) * length - 0.5;
        
        if (index < 0) index = 0;
        if (index > length - 1) index = length - 1;

        const lowerIndex = Math.floor(index);
        const upperIndex = Math.ceil(index);
        
        if (lowerIndex === upperIndex) {
            return context.precision(values[lowerIndex]);
        }

        const fraction = index - lowerIndex;
        const result = values[lowerIndex] + fraction * (values[upperIndex] - values[lowerIndex]);

        return context.precision(result);
    };
}
