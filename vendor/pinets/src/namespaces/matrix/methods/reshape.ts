// SPDX-License-Identifier: AGPL-3.0-only

import { PineMatrixObject } from '../PineMatrixObject';
import { Context } from '../../../Context.class';

export function reshape(context: Context) {
    return (id: PineMatrixObject, rows: number, cols: number) => {
        const currentRows = id.matrix.length;
        const currentCols = currentRows > 0 ? id.matrix[0].length : 0;
        const currentSize = currentRows * currentCols;
        const newSize = rows * cols;

        if (currentSize !== newSize) {
            // Cannot reshape if element counts don't match
            //FIXME : handle this
        }

        const elements: any[] = [];
        for (let i = 0; i < currentRows; i++) {
            for (let j = 0; j < currentCols; j++) {
                elements.push(id.matrix[i][j]);
            }
        }

        // Pad or truncate if needed (though reshape usually implies same size)
        while (elements.length < newSize) elements.push(NaN);
        if (elements.length > newSize) elements.length = newSize;

        const newMatrix: any[][] = [];
        let k = 0;
        for (let i = 0; i < rows; i++) {
            const row: any[] = [];
            for (let j = 0; j < cols; j++) {
                row.push(elements[k++]);
            }
            newMatrix.push(row);
        }

        id.matrix = newMatrix;
    };
}
