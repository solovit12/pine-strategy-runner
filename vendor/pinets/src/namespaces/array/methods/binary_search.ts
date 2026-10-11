import { PineArrayObject } from '../PineArrayObject';

export function binary_search(context: any) {
    return (id: PineArrayObject, value: any): number => {
        const array = id.array;
        let low = 0;
        let high = array.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const midVal = array[mid];

            if (midVal === value) {
                return mid;
            }

            if (midVal < value) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return -1;
    };
}

