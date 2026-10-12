import { AlertTriangle } from 'lucide-react';
import { usStockMarketState } from '../lib/stock-hours';
import { InfoTooltip } from './TranslatedText';

const NOW: Record<ReturnType<typeof usStockMarketState>, string> = {
  weekend: 'Now: weekend, their home exchanges are closed.',
  'closed-hours': 'Now: US stock exchanges are closed (open 9:30–16:00 New York time, Monday to Friday).',
  open: 'Now: US stock exchanges are open.',
};

/**
 * xyz markets trade around the clock on Hyperliquid, but their real price is set on stock and
 * commodity exchanges; when those are closed the book is thin and the price can jump at the open.
 */
export function XyzHoursNotice({ markets, nowMs = Date.now(), onlyWhenClosed = false }: {
  markets: readonly string[]; nowMs?: number; onlyWhenClosed?: boolean;
}) {
  const state = usStockMarketState(nowMs);
  if (markets.length === 0 || (onlyWhenClosed && state === 'open')) return null;
  return <div className="paper-xyz-notice" role="note">
    <AlertTriangle size={16} />
    <div>
      <strong>{markets.join(', ')}: stock and commodity markets <InfoTooltip label="xyz market hours"
        en="Hyperliquid trades xyz markets around the clock, but their real price is made on stock and commodity exchanges. At night, at weekends and on exchange holidays few people trade them: the order book is thin, fills can be worse, and the price can jump when the home exchange opens. Paper fills against this real book, so results in those hours can differ a lot from normal hours."
        ru="Hyperliquid торгует рынками xyz круглосуточно, но их настоящую цену задают фондовые и товарные биржи. Ночью, в выходные и в праздники биржи ими торгуют мало: стакан тонкий, исполнение может быть хуже, а на открытии биржи цена может прыгнуть. Paper исполняет заявки по этому настоящему стакану, поэтому результаты в эти часы могут сильно отличаться от обычных." /></strong>
      <span>Outside their home exchange's hours (nights, weekends, holidays) they trade thinly and can jump at the open. {NOW[state]}</span>
    </div>
  </div>;
}
