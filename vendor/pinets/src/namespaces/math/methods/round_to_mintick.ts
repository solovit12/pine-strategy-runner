// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';
import { Context } from '../../../Context.class';

export function round_to_mintick(context: Context) {
    return (source: any) => {
        return context.precision(Math.round(Series.from(source).get(0) / context.pine.syminfo.mintick) * context.pine.syminfo.mintick);
    };
}
