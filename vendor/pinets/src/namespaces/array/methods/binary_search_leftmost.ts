import { PineArrayObject } from '../PineArrayObject';

export function binary_search_leftmost(context: any) {
    return (id: PineArrayObject, value: any): number => {
        const array = id.array;
        let low = 0;
        let high = array.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (array[mid] < value) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        
        // low is lower_bound (first element >= value)

        // Check if found
        if (low < array.length && array[low] === value) {
             return low;
        }

        // If not found, return left of insertion point
        return low - 1;
    };
}

