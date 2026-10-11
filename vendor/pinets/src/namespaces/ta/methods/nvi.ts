// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Negative Volume Index (NVI)
 *
 * Formula:
 * If close or close[1] is 0, nvi = nvi[1]
 * Else if volume < volume[1], nvi = nvi[1] + ((close - close[1]) / close[1]) * nvi[1]
 * Else nvi = nvi[1]
 * Initial value is 1.0
 */
export function nvi(context: any) {
    return (_callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'nvi';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed NVI
                committedNVI: 1.0,
                // Tentative NVI
                tentativeNVI: 1.0,
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.committedNVI = state.tentativeNVI;
            }
            state.lastIdx = context.idx;
        }

        const close = context.get(context.data.close, 0);
        const prevClose = context.get(context.data.close, 1);
        const volume = context.get(context.data.volume, 0);
        const prevVolume = context.get(context.data.volume, 1);

        // Treat NaN as 0 for nz() behavior
        const c0 = isNaN(close) ? 0 : close;
        const c1 = isNaN(prevClose) ? 0 : prevClose;
        const v0 = isNaN(volume) ? 0 : volume;
        const v1 = isNaN(prevVolume) ? 0 : prevVolume;

        let currentNVI = state.committedNVI;

        if (c0 === 0 || c1 === 0) {
            // nvi remains the same
        } else {
            if (v0 < v1) {
                const change = (c0 - c1) / c1;
                currentNVI = currentNVI + change * currentNVI;
            }
            // else nvi remains the same
        }

        // Update tentative state
        state.tentativeNVI = currentNVI;

        return context.precision(currentNVI);
    };
}
