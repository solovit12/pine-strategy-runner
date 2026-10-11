// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';

export function some(context: any) {
    return (id: PineArrayObject): boolean => {
        return id.array.some((value: number) => !isNaN(value) && value);
    };
}
