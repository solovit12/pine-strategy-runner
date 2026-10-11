// SPDX-License-Identifier: AGPL-3.0-only

import { PineMatrixObject } from '../PineMatrixObject';
import { Context } from '../../../Context.class';
import { PineArrayObject } from '../../array/PineArrayObject';
import { inferValueType } from '@pinets/namespaces/array/utils';

export function remove_col(context: Context) {
    return (id: PineMatrixObject, column_index: number) => {
        const rows = id.matrix.length;
        if (rows === 0) {
            const anyType = inferValueType(id.matrix[0][0]);
            return new PineArrayObject([], anyType as any, context);
        }

        const removedValues = [];
        for (let i = 0; i < rows; i++) {
            const removed = id.matrix[i].splice(column_index, 1);
            removedValues.push(removed[0]);
        }
        const removedValueType = inferValueType(removedValues[0]);
        return new PineArrayObject(removedValues, removedValueType as any, context);
    };
}
