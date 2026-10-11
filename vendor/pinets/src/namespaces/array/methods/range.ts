// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { Context } from '../../../Context.class';

export function range(context: Context) {
    return (id: PineArrayObject): number => {
        return context.precision(context.pine.array.max(id) - context.pine.array.min(id));
    };
}
