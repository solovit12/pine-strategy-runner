// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { Context } from '../../../Context.class';

export function sum(context: Context) {
    return (id: PineArrayObject): number => {
        return context.precision(
            id.array.reduce((a: number, b: any) => {
                const val = Number(b);
                return isNaN(val) ? a : a + val;
            }, 0)
        );
    };
}
