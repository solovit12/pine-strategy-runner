// SPDX-License-Identifier: AGPL-3.0-only

import { PineMapObject } from '../PineMapObject';
import { Context } from '../../../Context.class';
import { PineArrayObject } from '../../array/PineArrayObject';
import { inferValueType } from '@pinets/namespaces/array/utils';

export function values(context: Context) {
    return (id: PineMapObject) => {
        const valuesArray = Array.from(id.map.values());
        const valueType = inferValueType(valuesArray[0]);
        return new PineArrayObject(valuesArray, valueType as any, context);
    };
}
