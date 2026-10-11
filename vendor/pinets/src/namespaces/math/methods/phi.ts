// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Golden ratio (φ, phi)
 * Calculated as (1 + sqrt(5)) / 2, approximately 1.618033988749895
 */
export function phi(context: any) {
    return () => {
        // Golden ratio: (1 + sqrt(5)) / 2
        return 1.618033988749895;
    };
}
