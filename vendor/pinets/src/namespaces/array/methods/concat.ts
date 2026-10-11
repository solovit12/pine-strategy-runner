// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { isArrayOfType } from '../utils';

export function concat(context: any) {
    return (id: PineArrayObject, other: PineArrayObject): PineArrayObject => {
        id.array.push(...other.array);
        return id;
    };
}
