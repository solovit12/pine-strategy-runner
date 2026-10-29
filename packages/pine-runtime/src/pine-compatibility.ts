import { BACKTEST_TIMEFRAME_MS } from '../../shared/src/contracts.js';
import { pineTimeframeMs, plainSymbol } from './series-requests.js';

/**
 * Pine features this service runs differently from TradingView, found in the code before a run.
 * `stop`: the run stops on it. `differs`: the run goes on, but results can differ from TradingView.
 * A static reading of the code: only literal arguments are judged, computed ones are skipped
 * unless the run would stop whatever they are.
 */
export type PineCompatibilityLevel = 'stop' | 'differs';

export interface PineCompatibilityIssue {
  readonly level: PineCompatibilityLevel;
  /** 1-based line of the code the issue is about. */
  readonly line: number;
  /** Where it applies: every run, backtests only or Paper only. */
  readonly where: 'all' | 'backtest' | 'paper';
  readonly message: string;
}

export interface PineCompatibilityContext {
  /** The backtest market, e.g. BTCUSDT (Paper trades many markets: leave it out). */
  readonly chartSymbol?: string;
  /** The chart timeframe of the run, e.g. 1h. */
  readonly chartTimeframe?: string;
}

const MISSING_REQUESTS = ['financial', 'economic', 'earnings', 'dividends', 'splits', 'seed', 'quandl', 'currency_rate'];

/** Comments and the inside of quotes become spaces; positions and line breaks stay. */
function mask(source: string): string {
  let out = '';
  let quote: string | null = null;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (comment) {
      if (char === '\n') { comment = false; out += char; } else out += ' ';
    } else if (quote) {
      if (char === '\\' && index + 1 < source.length && source[index + 1] !== '\n') { out += '  '; index += 1; }
      else if (char === quote || char === '\n') { quote = null; out += char === '\n' ? '\n' : ' '; }
      else out += ' ';
    } else if (char === '/' && source[index + 1] === '/') {
      comment = true; out += ' ';
    } else if (char === '"' || char === "'") {
      quote = char; out += ' ';
    } else out += char;
  }
  return out;
}

interface Call {
  readonly start: number;
  /** Arguments as written in the code (comments and strings intact). */
  readonly args: readonly string[];
}

/** Every call of `name(...)` with its top-level arguments; an unfinished call is skipped. */
function calls(source: string, masked: string, name: RegExp): Call[] {
  const found: Call[] = [];
  const pattern = new RegExp(`(?<![\\w.])${name.source}\\s*\\(`, 'g');
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    const open = match.index + match[0].length - 1;
    const args: string[] = [];
    let depth = 0;
    let from = open + 1;
    let closed = false;
    for (let index = open + 1; index < masked.length; index += 1) {
      const char = masked[index]!;
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        if (depth === 0) { args.push(source.slice(from, index)); closed = true; break; }
        depth -= 1;
      } else if (char === ',' && depth === 0) { args.push(source.slice(from, index)); from = index + 1; }
    }
    if (closed) found.push({ start: match.index, args: args.map((arg) => arg.trim()).filter(Boolean) });
  }
  return found;
}

/** A named argument (`name=value`), else the positional one at `position`. */
function argument(call: Call, name: string, position: number): string | undefined {
  const named = call.args.find((arg) => new RegExp(`^${name}\\s*=(?!=)`).test(arg));
  if (named) return named.slice(named.indexOf('=') + 1).trim();
  const positional = call.args.filter((arg) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(arg));
  return positional[position];
}

function literal(text: string | undefined): string | undefined {
  const match = text === undefined ? null : /^(["'])((?:\\.|(?!\1).)*)\1$/s.exec(text);
  return match ? match[2] : undefined;
}

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length;

export function pineCompatibility(source: string, context: PineCompatibilityContext = {}): PineCompatibilityIssue[] {
  const masked = mask(source);
  const issues: PineCompatibilityIssue[] = [];
  const add = (index: number, level: PineCompatibilityLevel, where: PineCompatibilityIssue['where'], message: string) => {
    issues.push({ level, line: lineAt(source, index), where, message });
  };
  const chartMs = context.chartTimeframe
    ? BACKTEST_TIMEFRAME_MS[context.chartTimeframe as keyof typeof BACKTEST_TIMEFRAME_MS] : undefined;

  for (const [index, fn] of [...masked.matchAll(new RegExp(`(?<![\\w.])request\\s*\\.\\s*(${MISSING_REQUESTS.join('|')})\\s*\\(`, 'g'))]
    .map((match) => [match.index!, match[1]!] as const)) {
    add(index, 'stop', 'all', `request.${fn} is not available here: this service has exchange prices only.`);
  }

  for (const call of calls(source, masked, /request\s*\.\s*security(?:_lower_tf)?/)) {
    const lower = /_lower_tf/.test(masked.slice(call.start, call.start + 40));
    const name = lower ? 'request.security_lower_tf' : 'request.security';
    const symbol = argument(call, 'symbol', 0) ?? '';
    // A ticker in quotes, also inside ticker.new("BINANCE", "SOLUSDT"): the part naming the market.
    const quoted = [...symbol.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2]!);
    const ticker = quoted.find((text) => text.includes(':')) ?? quoted.at(-1);
    if (/\bticker\s*\.\s*heikinashi\b/.test(symbol) || /;\s*heikinashi/i.test(symbol)) {
      add(call.start, 'differs', 'all', `${name} asks for Heikin Ashi candles; this service uses regular candles instead.`);
    } else if (ticker !== undefined && ticker.trim() !== ''
      && !(context.chartSymbol && plainSymbol(ticker) === plainSymbol(context.chartSymbol))) {
      add(call.start, 'stop', 'all', `${name} asks for another market (${ticker}); only the run's own market prices are available.`);
    } else if (ticker === undefined && symbol !== '' && !/\bsyminfo\s*\.\s*(tickerid|ticker)\b/.test(symbol)) {
      add(call.start, 'differs', 'all', `${name} uses a market chosen in the code; if it is another market, the run stops.`);
    }

    const timeframe = literal(argument(call, 'timeframe', 1));
    if (timeframe === undefined || timeframe.trim() === '') continue;
    const timeframeMs = pineTimeframeMs(timeframe);
    if (timeframeMs === null) {
      add(call.start, 'stop', 'all', `${name} asks for the "${timeframe}" timeframe; only minutes that divide a day evenly, D and W are available.`);
    } else if (lower) {
      add(call.start, 'stop', 'paper', `${name} is not available: a timeframe lower than the chart's is not built from live prices.`);
    } else if (chartMs && (timeframeMs < chartMs || timeframeMs % chartMs !== 0)) {
      add(call.start, 'stop', 'paper', `${name} needs the chart timeframe (${context.chartTimeframe}) or a whole multiple of it; "${timeframe}" is not.`);
    }
  }

  for (const call of calls(source, masked, /strategy\s*\.\s*exit/)) {
    const trailing = call.args.some((arg) => /^trail_(points|price)\s*=/.test(arg));
    if (trailing && !call.args.some((arg) => /^trail_offset\s*=/.test(arg))) {
      add(call.start, 'stop', 'backtest', 'strategy.exit has a trailing stop without trail_offset, so it never triggers (TradingView ignores it); the backtest stops on it: remove trail_points / trail_price, or add trail_offset.');
    }
  }

  const ocaNames = new Map<string, { exits: number; total: number; first: number }>();
  for (const [kind, pattern] of [['exit', /strategy\s*\.\s*exit/], ['other', /strategy\s*\.\s*(?:entry|order)/]] as const) {
    for (const call of calls(source, masked, pattern)) {
      const oca = literal(argument(call, 'oca_name', 99));
      if (!oca) continue;
      const group = ocaNames.get(oca) ?? { exits: 0, total: 0, first: call.start };
      if (kind === 'exit') {
        if (group.exits === 0) group.first = call.start;
        group.exits += 1;
      }
      group.total += 1;
      ocaNames.set(oca, group);
    }
  }
  for (const [oca, group] of ocaNames) {
    if (group.exits > 0 && group.total > 1) {
      add(group.first, 'stop', 'backtest', `strategy.exit shares the OCA group "${oca}" with another order; that is not supported yet.`);
    }
  }

  for (const call of calls(source, masked, /strategy\s*\.\s*close(?:_all)?/)) {
    if (call.args.some((arg) => /^immediately\s*=\s*true\b/.test(arg))) {
      add(call.start, 'stop', 'backtest', 'immediately=true is not supported in the minute-by-minute backtest.');
    }
  }

  const declaration = calls(source, masked, /strategy/).find((call) => /^\s*$/.test(masked.slice(masked.lastIndexOf('\n', call.start) + 1, call.start)));
  for (const option of ['calc_on_every_tick', 'calc_on_order_fills']) {
    if (declaration?.args.some((arg) => new RegExp(`^${option}\\s*=\\s*true\\b`).test(arg))) {
      add(declaration.start, 'differs', 'all', `${option}=true: here the strategy is calculated once per closed bar, so results can differ from TradingView.`);
    }
  }

  for (const [pattern, what] of [[/(?<![\w.])varip\b/, 'varip'], [/\bbarstate\s*\.\s*isrealtime\b/, 'barstate.isrealtime'],
    [/(?<![\w.])timenow\b/, 'timenow']] as const) {
    const match = new RegExp(pattern.source).exec(masked);
    if (match) {
      add(match.index, 'differs', 'paper', `${what}: the code runs only on closed bars, so this part behaves differently from TradingView.`);
    }
  }

  return issues.sort((a, b) => (a.level === b.level ? a.line - b.line : a.level === 'stop' ? -1 : 1));
}
