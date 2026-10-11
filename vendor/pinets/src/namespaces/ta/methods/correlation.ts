// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Correlation Coefficient
 *
 * Describes the degree to which two series tend to deviate from their ta.sma() values.
 * r = cov(X, Y) / (stdev(X) * stdev(Y))
 */
export function correlation(context: any) {
    return (source1: any, source2: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const s1 = Series.from(source1);
        const s2 = Series.from(source2);

        if (context.idx < length - 1) {
            return NaN;
        }

        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumX2 = 0;
        let sumY2 = 0;
        let count = 0;

        for (let i = 0; i < length; i++) {
            const x = s1.get(i);
            const y = s2.get(i);

            if (isNaN(x) || isNaN(y)) continue;

            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
            sumY2 += y * y;
            count++;
        }

        if (count < 2) return NaN; // Need at least 2 points

        const numerator = count * sumXY - sumX * sumY;
        const denominatorX = count * sumX2 - sumX * sumX;
        const denominatorY = count * sumY2 - sumY * sumY;

        if (denominatorX <= 0 || denominatorY <= 0) return context.precision(0);

        const r = numerator / Math.sqrt(denominatorX * denominatorY);
        return context.precision(r);
    };
}

