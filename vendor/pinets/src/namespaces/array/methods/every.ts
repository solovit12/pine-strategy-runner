// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';

export function every(context: any) {
    return (id: PineArrayObject): boolean => {
        return id.array.every((value: number) => !isNaN(value) && value);
    };
}
