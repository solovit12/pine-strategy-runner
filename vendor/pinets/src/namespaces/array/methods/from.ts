// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
import { inferArrayType } from '../utils';

export function from(context: any) {
    return (...values: any[]): PineArrayObject => {
        return new PineArrayObject([...values], inferArrayType(values), context);
    };
}
