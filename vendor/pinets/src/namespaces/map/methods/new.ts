// SPDX-License-Identifier: AGPL-3.0-only

import { PineMapObject } from '../PineMapObject';
import { Context } from '../../../Context.class';

export function new_fn(context: Context) {
    return (): PineMapObject => {
        return new PineMapObject(context);
    };
}
