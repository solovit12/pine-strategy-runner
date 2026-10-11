// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { Context } from '../../../Context.class';

export function variance(context: Context) {
    return (id: PineArrayObject, biased: boolean = true): number => {
        // Inline Naive Avg to match legacy behavior for variance calculation
        let sum = 0;
        let count = 0;
        for (const item of id.array) {
            const val = Number(item);
            if (!isNaN(val) && val !== null && val !== undefined) {
                sum += val;
                count++;
            }
        }

        if (count === 0) return NaN;
        const mean = sum / count;

        // Two-Pass Variance Calculation
        let sumSqDiff = 0;
        for (const item of id.array) {
            const val = Number(item);
            if (!isNaN(val) && val !== null && val !== undefined) {
                sumSqDiff += (val - mean) * (val - mean);
            }
        }

        const divisor = biased ? count : count - 1;
        if (divisor <= 0) return NaN;

        return context.precision(sumSqDiff / divisor);
    };
}
