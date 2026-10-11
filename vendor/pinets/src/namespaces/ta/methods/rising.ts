// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Rising Detection
 *
 * Tests if the source series is now rising for length bars long.
 * Returns true if the series has been consecutively rising for length bars.
 *
 * Formula:
 * For length=2: source[0] > source[1] AND source[1] > source[2]
 * For length=n: source[i] > source[i+1] for all i from 0 to n-1
 *
 * @param source - Series of values to process
 * @param length - Number of bars to check (lookback period)
 * @returns true if consecutively rising for length bars, false otherwise
 */
export function rising(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const series = Series.from(source);

        // Check consecutive increases for length bars
        // For length=2: check if source[0] > source[1] && source[1] > source[2]
        for (let i = 0; i < length; i++) {
            const current = series.get(i);
            const next = series.get(i + 1);
            
            // If either value is NaN, return false
            if (isNaN(current) || isNaN(next)) {
                return false;
            }

            // If not increasing, return false
            if (current <= next) {
                return false;
            }
        }

        return true;
    };
}

