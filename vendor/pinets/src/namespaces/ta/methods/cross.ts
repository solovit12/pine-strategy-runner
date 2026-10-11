// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Cross Detection
 *
 * Detects when two series cross each other (either direction).
 * Returns true if series1 crosses series2 (either above or below).
 *
 * Formula:
 * cross = (source1[0] > source2[0] && source1[1] <= source2[1]) ||
 *         (source1[0] < source2[0] && source1[1] >= source2[1])
 *
 * @param source1 - First data series
 * @param source2 - Second data series
 * @returns true if the series have crossed, false otherwise
 */
export function cross(context: any) {
    return (source1: any, source2: any, _callId?: string) => {
        const series1 = Series.from(source1);
        const series2 = Series.from(source2);

        // Stateless calculation (accesses past data via Series)
        
        const current1 = series1.get(0);
        const current2 = series2.get(0);
        const prev1 = series1.get(1);
        const prev2 = series2.get(1);

        // If any value is NaN, return false
        if (isNaN(current1) || isNaN(current2) || isNaN(prev1) || isNaN(prev2)) {
            return false;
        }

        // Check if series1 crossed above series2 (crossover)
        const crossedOver = current1 > current2 && prev1 <= prev2;

        // Check if series1 crossed below series2 (crossunder)
        const crossedUnder = current1 < current2 && prev1 >= prev2;

        return crossedOver || crossedUnder;
    };
}
