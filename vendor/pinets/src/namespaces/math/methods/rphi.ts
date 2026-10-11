// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reciprocal of golden ratio (1/φ)
 * Equal to phi - 1, approximately 0.6180339887498948
 */
export function rphi(context: any) {
    return () => {
        // Reciprocal of golden ratio: 1/phi = phi - 1
        return 0.6180339887498948;
    };
}
