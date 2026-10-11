// SPDX-License-Identifier: AGPL-3.0-only

import { PineArrayObject } from '../PineArrayObject';
/**
 * Joins the elements of the array into a string, separated by the separator.
 * @param context - The context of the array.
 * @returns The string of the joined elements.
 */
export function join(context: any) {
    return (id: PineArrayObject, separator: string = ','): string => {
        return id.array.join(separator);
    };
}
