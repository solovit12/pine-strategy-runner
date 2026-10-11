// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';

export function percentrank(context: any) {
    return (id: PineArrayObject, index: number): number => {
        if (id.array.length === 0) return NaN;

        const idx = Math.floor(index);

        // Check bounds
        if (idx < 0 || idx >= id.array.length) return NaN;

        const value = Number(id.array[idx]);

        // If reference value is NaN, result is NaN
        if (isNaN(value) || value === null || value === undefined) return NaN;

        let lessThan = 0;

        for (const item of id.array) {
            const val = Number(item);
            if (!isNaN(val) && val !== null && val !== undefined) {
                if (val < value) {
                    lessThan++;
                }
            }
        }

        const divisor = id.array.length - 1;
        if (divisor <= 0) return NaN;

        return (lessThan / divisor) * 100;
    };
}
