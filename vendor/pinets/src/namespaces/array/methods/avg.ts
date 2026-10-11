// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { Context } from '../../../Context.class';

export function avg(context: Context) {
    return (id: PineArrayObject): number => {
        let mean = 0;
        let count = 0;
        for (const item of id.array) {
            const val = Number(item);
            if (!isNaN(val)) {
                count++;
                mean += (val - mean) / count;
            }
        }
        if (count === 0) return NaN;
        return context.precision(mean);
    };
}
