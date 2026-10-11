// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Mode
 *
 * Returns the mode of the series. If there are several values with the same frequency, returns the smallest value.
 */
export function mode(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const series = Series.from(source);

        if (context.idx < length - 1) {
            return NaN;
        }

        const counts = new Map<number, number>();
        
        for (let i = 0; i < length; i++) {
            const val = series.get(i);
            if (isNaN(val)) continue;
            
            counts.set(val, (counts.get(val) || 0) + 1);
        }

        if (counts.size === 0) return NaN;

        let modeVal = NaN;
        let maxFreq = -1;

        for (const [val, freq] of counts.entries()) {
            if (freq > maxFreq) {
                maxFreq = freq;
                modeVal = val;
            } else if (freq === maxFreq) {
                if (val < modeVal) {
                    modeVal = val;
                }
            }
        }

        return modeVal; // Should I return int or float? Input determines it. Return value is as-is.
    };
}

