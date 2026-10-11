/**
 * Strategy Properties declared in Pine's `strategy(...)` call. Like TradingView,
 * the editor form starts from these values; the form still wins at run time.
 * Only literal values are read; anything computed is left to the form.
 */
export interface StrategyDeclarationProperties {
  readonly initialCapital?: number;
  readonly defaultOrderSizeType?: 'fixed' | 'cash' | 'percent_of_equity';
  readonly defaultOrderSizeValue?: number;
  readonly pyramiding?: number;
  readonly commissionPercent?: number;
  readonly processOrdersOnClose?: boolean;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ORDER_TYPES = {
  'strategy.fixed': 'fixed',
  'strategy.cash': 'cash',
  'strategy.percent_of_equity': 'percent_of_equity',
} as const;

/** Top-level arguments of the first `strategy(` call, or null when there is none. */
function strategyArguments(source: string): string[] | null {
  const start = /^[ \t]*strategy\s*\(/m.exec(source);
  if (!start) return null;
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let index = start.index + start[0].length; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      current += char;
      if (char === '\\') { current += source[index + 1] ?? ''; index += 1; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') {
      if (depth === 0) { args.push(current); return args; }
      depth -= 1;
    } else if (char === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += char;
  }
  return null; // unfinished call while the user is still typing
}

export function strategyDeclarationProperties(source: string): StrategyDeclarationProperties {
  const named = new Map<string, string>();
  for (const arg of strategyArguments(source) ?? []) {
    const match = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*?)\s*$/.exec(arg);
    if (match) named.set(match[1]!, match[2]!);
  }
  const number = (name: string) => {
    const raw = named.get(name);
    return raw !== undefined && NUMBER.test(raw) ? Number(raw) : undefined;
  };
  const orderType = named.get('default_qty_type');
  const commissionType = named.get('commission_type');
  const percentCommission = commissionType === undefined || commissionType === 'strategy.commission.percent';
  const result: { -readonly [K in keyof StrategyDeclarationProperties]: StrategyDeclarationProperties[K] } = {};
  const initialCapital = number('initial_capital');
  if (initialCapital !== undefined && initialCapital > 0) result.initialCapital = initialCapital;
  if (orderType !== undefined && orderType in ORDER_TYPES) {
    result.defaultOrderSizeType = ORDER_TYPES[orderType as keyof typeof ORDER_TYPES];
  }
  const orderValue = number('default_qty_value');
  if (orderValue !== undefined && orderValue > 0) result.defaultOrderSizeValue = orderValue;
  const pyramiding = number('pyramiding');
  if (pyramiding !== undefined && Number.isInteger(pyramiding) && pyramiding >= 0) result.pyramiding = pyramiding;
  const commission = number('commission_value');
  if (percentCommission && commission !== undefined && commission >= 0) result.commissionPercent = commission;
  const onClose = named.get('process_orders_on_close');
  if (onClose === 'true' || onClose === 'false') result.processOrdersOnClose = onClose === 'true';
  return result;
}

/** Values whose declaration changed since `previous`; the user's form edits to other fields stay. */
export function changedDeclarationProperties(previous: StrategyDeclarationProperties,
  next: StrategyDeclarationProperties): StrategyDeclarationProperties {
  return Object.fromEntries(Object.entries(next)
    .filter(([key, value]) => previous[key as keyof StrategyDeclarationProperties] !== value));
}
