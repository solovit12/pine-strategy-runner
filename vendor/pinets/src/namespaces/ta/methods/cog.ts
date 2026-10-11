// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Center of Gravity (COG)
 *
 * The cog (center of gravity) is an indicator based on statistics and the Fibonacci golden ratio.
 *
 * Pine Script Formula:
 * sum = sum(source, length)
 * num = 0.0
 * for i = 0 to length - 1
 *     price = source[i]
 *     num = num + price * (i + 1)
 * cog = -num / sum
 *
 * @param source - Source series (typically close)
 * @param length - Number of bars (lookback period)
 * @returns Center of Gravity value
 */
export function cog(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.from(_length).get(0);
        const sourceSeries = Series.from(source);

        // Calculate sum of source over length period
        let sum = 0;
        let hasNaN = false;

        for (let i = 0; i < length; i++) {
            const value = sourceSeries.get(i);
            if (isNaN(value)) {
                hasNaN = true;
                break;
            }
            sum += value;
        }

        // Return NaN if we don't have enough data
        if (hasNaN) {
            return NaN;
        }

        // Calculate weighted sum
        // num = sum of (price[i] * (i + 1))
        let num = 0;
        for (let i = 0; i < length; i++) {
            const price = sourceSeries.get(i);
            num += price * (i + 1);
        }

        // Avoid division by zero
        if (sum === 0) {
            return NaN;
        }

        // Calculate COG
        const cog = -num / sum;

        return context.precision(cog);
    };
}

