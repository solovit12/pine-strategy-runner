// SPDX-License-Identifier: AGPL-3.0-only

export function findLTFContextIdx(
    myOpenTime: number,
    myCloseTime: number,
    openTime: number[],
    closeTime: number[],
    lookahead: boolean = false,
    mainContextEDate?: number,
    gaps: boolean = false
): number {
    // Find the latest intrabar that is fully contained within the chart bar [myOpenTime, myCloseTime]
    for (let i = openTime.length - 1; i >= 0; i--) {
        if (closeTime[i] <= myCloseTime && openTime[i] >= myOpenTime) {
            // Found the last intrabar for this chart bar

            // Check if we're on an incomplete/current bar:
            // If eDate is defined and the bar extends beyond it, this is the current bar being processed
            const isCurrentBar = mainContextEDate && myCloseTime > mainContextEDate;

            // For LTF with gaps=true and lookahead=true: ALWAYS return first intrabar (not just current bar)
            if (gaps && lookahead) {
                for (let j = 0; j < openTime.length; j++) {
                    if (openTime[j] >= myOpenTime && openTime[j] < myCloseTime) {
                        return j;
                    }
                    if (openTime[j] >= myCloseTime) {
                        break;
                    }
                }
            }

            // For current bar with lookahead=true (and gaps=false): return the FIRST intrabar
            if (isCurrentBar && lookahead && !gaps) {
                for (let j = 0; j < openTime.length; j++) {
                    if (openTime[j] >= myOpenTime && openTime[j] < myCloseTime) {
                        return j;
                    }
                    if (openTime[j] >= myCloseTime) {
                        break;
                    }
                }
            }

            // For historical bars OR lookahead=false: return the last intrabar
            return i;
        }

        // Optimization: if the bar closes before our bar opens, we went too far back
        if (closeTime[i] < myOpenTime) {
            break;
        }
    }

    return -1;
}
