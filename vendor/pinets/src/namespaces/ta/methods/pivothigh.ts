// SPDX-License-Identifier: AGPL-3.0-only

import { pivothigh as pivothighUtil } from '../utils/pivothigh';
import { Series } from '../../../Series';

export function pivothigh(context: any) {
    return (source: any, _leftbars: any, _rightbars: any, _callId?: string) => {
        //handle the case where source is not provided, in that case _rightbars will receive the _callId from the transpiler (a string value)
        if (typeof _rightbars === 'string') {
            _rightbars = _leftbars;
            _leftbars = source;
            _callId = _rightbars;

            //by default source is
            source = context.data.high;
        }
        const leftbars = Series.from(_leftbars).get(0);
        const rightbars = Series.from(_rightbars).get(0);

        // Stateless calculation using full array history
        const sourceArray = Series.from(source).toArray();
        const result = pivothighUtil(sourceArray, leftbars, rightbars);
        const idx = context.idx;
        return context.precision(result[idx]);
    };
}
