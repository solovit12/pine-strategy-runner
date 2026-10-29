// SPDX-License-Identifier: AGPL-3.0-only

import { PineRuntimeError } from './PineRuntimeError';

/**
 * A read of a bar that a history limit (`PineTS.setHistoryLimit`) already dropped.
 * Nothing is guessed for that bar: the run stops, and the caller may run again with
 * a longer history.
 */
export class PineHistoryLimitError extends PineRuntimeError {
    constructor(
        /** Bars back the read asked for. */
        public readonly lookback: number,
        /** Past bars the limit keeps. */
        public readonly limit: number,
    ) {
        super(`The script reads a value ${lookback} bars back, but this run keeps only the last ${limit} bars of history.`);
        this.name = 'PineHistoryLimitError';
    }
}
