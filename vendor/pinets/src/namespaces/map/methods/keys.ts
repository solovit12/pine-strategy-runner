// SPDX-License-Identifier: AGPL-3.0-only

import { PineMapObject } from '../PineMapObject';
import { Context } from '../../../Context.class';
import { PineArrayObject } from '../../array/PineArrayObject';
import { inferValueType } from '@pinets/namespaces/array/utils';

export function keys(context: Context) {
    return (id: PineMapObject) => {
        const keysArray = Array.from(id.map.keys());
        const keyType = inferValueType(keysArray[0]);
        return new PineArrayObject(keysArray, keyType as any, context);
    };
}
