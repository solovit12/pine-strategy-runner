import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { NormalizedTrade } from '../../../../packages/shared/src/contracts';

const LONG_COLOR = '#63dda5';
const SHORT_COLOR = '#ff8b8c';
const EXIT_COLOR = '#f3b24c';

function timeOf(value: string): UTCTimestamp {
  return Math.floor(Date.parse(value) / 1_000) as UTCTimestamp;
}

function quantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));
}

function entryMarker(trade: NormalizedTrade, size = trade.size): SeriesMarker<UTCTimestamp> {
  const isLong = trade.side === 'long';
  return {
    time: timeOf(trade.entryTime),
    position: isLong ? 'belowBar' : 'aboveBar',
    color: isLong ? LONG_COLOR : SHORT_COLOR,
    shape: isLong ? 'arrowUp' : 'arrowDown',
    text: `${isLong ? 'LONG +' : 'SHORT −'}${quantity(size)}`,
  };
}

function exitMarker(trade: NormalizedTrade): SeriesMarker<UTCTimestamp> {
  const isLong = trade.side === 'long';
  return {
    time: timeOf(trade.exitTime),
    position: isLong ? 'aboveBar' : 'belowBar',
    color: EXIT_COLOR,
    shape: isLong ? 'arrowDown' : 'arrowUp',
    text: 'EXIT',
  };
}

export function buildTradeMarkers(trades: NormalizedTrade[]): SeriesMarker<UTCTimestamp>[] {
  const markers: SeriesMarker<UTCTimestamp>[] = [];
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index]!;
    const previous = trades[index - 1];
    const isReversalEntry = previous
      && previous.exitTime === trade.entryTime
      && previous.side !== trade.side;
    const next = trades[index + 1];
    const isReversalExit = next
      && trade.exitTime === next.entryTime
      && trade.side !== next.side;

    if (isReversalEntry) markers.push(entryMarker(trade, trade.size + previous.size));
    else markers.push(entryMarker(trade));
    if (!isReversalExit) markers.push(exitMarker(trade));
  }
  return markers.sort((left, right) => Number(left.time) - Number(right.time));
}
