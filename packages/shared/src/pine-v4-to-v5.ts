/**
 * Pine Script v4 → v5 in the editor, following TradingView's "To Pine Script version 5" migration guide:
 * functions move into namespaces (ta., math., request., ticker., str.), input() gets its type
 * (input.int, input.bool, …), iff() becomes ?:, transp= moves into color.new(), study() becomes
 * indicator(), strategy.entry's true/false becomes strategy.long/strategy.short.
 *
 * Also the `when` condition of strategy orders (`when=`, or unnamed as in strategy.close("L", cond)) moves into
 * an `if`, in v4 and v5 code alike: v5 still accepts `when`, but this service's engine ignores it, so the order
 * would be sent on every bar.
 *
 * A text rewrite that keeps the rest of the code (comments, spacing, line breaks) as written.
 */

export interface PineConversion {
  readonly source: string;
  /** How many places were rewritten. */
  readonly changes: number;
  /** Places left as they were that need a look, each with its code. */
  readonly notes: readonly string[];
}

type Kind = 'ws' | 'nl' | 'comment' | 'str' | 'num' | 'id' | 'op' | 'raw';
interface Token { readonly kind: Kind; readonly text: string }

const OPERATORS = [':=', '==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%='];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const take = (kind: Kind, end: number) => { tokens.push({ kind, text: source.slice(index, end) }); index = end; };
  while (index < source.length) {
    const char = source[index]!;
    const rest = source.slice(index);
    if (char === '\n') take('nl', index + 1);
    else if (char === '\r' && source[index + 1] === '\n') take('nl', index + 2);
    else if (/[ \t\r]/.test(char)) take('ws', index + /^[ \t\r]+/.exec(rest)![0].length);
    else if (rest.startsWith('//')) take('comment', index + (/^[^\n]*/.exec(rest)![0].replace(/\r$/, '').length));
    else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      take('str', Math.min(source.length, end + (source[end] === char ? 1 : 0)));
    } else if (char === '#' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b/.test(rest)) take('num', index + /^#[0-9a-fA-F]+/.exec(rest)![0].length);
    else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      take('num', index + /^(\d*\.?\d*(?:[eE][+-]?\d+)?)/.exec(rest)![0].length);
    } else if (/[A-Za-z_]/.test(char)) take('id', index + /^[A-Za-z_]\w*/.exec(rest)![0].length);
    else take('op', index + (OPERATORS.find((op) => rest.startsWith(op))?.length ?? 1));
  }
  return tokens;
}

const text = (tokens: readonly Token[]) => tokens.map((token) => token.text).join('');
const raw = (value: string): Token => ({ kind: 'raw', text: value });
const significant = (token: Token | undefined) => token !== undefined && token.kind !== 'ws' && token.kind !== 'nl' && token.kind !== 'comment';

function nextSignificant(tokens: readonly Token[], from: number): number {
  let index = from;
  while (index < tokens.length && !significant(tokens[index])) index += 1;
  return index;
}

function previousSignificant(tokens: readonly Token[], from: number): Token | undefined {
  for (let index = from; index >= 0; index -= 1) if (significant(tokens[index])) return tokens[index];
  return undefined;
}

/** The arguments of the call whose "(" is at `open`, split at top-level commas; null if never closed. */
function callArguments(tokens: readonly Token[], open: number): { args: Token[][]; close: number } | null {
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let index = open + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === 'op' && (token.text === '(' || token.text === '[')) depth += 1;
    if (token.kind === 'op' && (token.text === ')' || token.text === ']')) {
      if (depth === 0) {
        if (args.length > 0 || current.some(significant)) args.push(current);
        return { args, close: index };
      }
      depth -= 1;
    }
    if (token.kind === 'op' && token.text === ',' && depth === 0) { args.push(current); current = []; continue; }
    current.push(token);
  }
  return null;
}

/** `name=` of a named argument, else null. */
function argumentName(arg: readonly Token[]): string | null {
  const first = nextSignificant(arg, 0);
  const equals = nextSignificant(arg, first + 1);
  return arg[first]?.kind === 'id' && arg[equals]?.kind === 'op' && arg[equals]!.text === '=' ? arg[first]!.text : null;
}

/** The value of an argument, without its `name=`, trimmed. */
function argumentValue(arg: readonly Token[]): string {
  if (argumentName(arg) === null) return text(arg).trim();
  const equals = nextSignificant(arg, nextSignificant(arg, 0) + 1);
  return text(arg.slice(equals + 1)).trim();
}

/** The same argument with another value (and name), its leading spacing kept. */
function withValue(arg: readonly Token[], value: string, name?: string): Token[] {
  const lead = text(arg.slice(0, nextSignificant(arg, 0)));
  const named = argumentName(arg);
  const label = name ?? named;
  if (label === null) return tokenize(`${lead}${value}`);
  if (named === null) return tokenize(`${lead}${label}=${value}`);
  const first = nextSignificant(arg, 0);
  const equals = nextSignificant(arg, first + 1);
  const between = text(arg.slice(first + 1, equals));
  const after = /^[ \t]*/.exec(text(arg.slice(equals + 1)))![0];
  return tokenize(`${lead}${label}${between}=${after}${value}`);
}

const TA = ['alma', 'atr', 'barssince', 'bb', 'bbw', 'cci', 'change', 'cmo', 'cog', 'correlation', 'cross', 'crossover',
  'crossunder', 'cum', 'dev', 'dmi', 'ema', 'falling', 'highest', 'highestbars', 'hma', 'kc', 'kcw', 'linreg', 'lowest',
  'lowestbars', 'macd', 'median', 'mfi', 'mode', 'mom', 'percentile_linear_interpolation', 'percentile_nearest_rank',
  'percentrank', 'pivothigh', 'pivotlow', 'range', 'rising', 'rma', 'roc', 'rsi', 'sar', 'sma', 'stdev', 'stoch',
  'supertrend', 'swma', 'tr', 'tsi', 'valuewhen', 'variance', 'vwap', 'vwma', 'wma', 'wpr'];
const MATH = ['abs', 'acos', 'asin', 'atan', 'avg', 'ceil', 'cos', 'exp', 'floor', 'log', 'log10', 'max', 'min', 'pow',
  'random', 'round', 'round_to_mintick', 'sign', 'sin', 'sqrt', 'sum', 'tan', 'todegrees', 'toradians'];
const RENAMED: Record<string, string> = {
  ...Object.fromEntries(TA.map((name) => [name, `ta.${name}`])),
  ...Object.fromEntries(MATH.map((name) => [name, `math.${name}`])),
  security: 'request.security', financial: 'request.financial', quandl: 'request.quandl', splits: 'request.splits',
  dividends: 'request.dividends', earnings: 'request.earnings', heikinashi: 'ticker.heikinashi', renko: 'ticker.renko',
  linebreak: 'ticker.linebreak', kagi: 'ticker.kagi', pointfigure: 'ticker.pointfigure', tickerid: 'ticker.new',
  tostring: 'str.tostring', tonumber: 'str.tonumber', study: 'indicator',
};
/** Built-in variables that became ta.* (only where the script has no variable of that name). */
const TA_VARIABLES = new Set(['accdist', 'iii', 'nvi', 'obv', 'pvi', 'pvt', 'tr', 'vwap', 'wad', 'wvad']);
/** The script's own names that v5 took for namespaces or keywords: renamed with a trailing "_". */
const TAKEN_IN_V5 = new Set(['ta', 'math', 'str', 'request', 'ticker', 'type', 'method', 'import', 'export', 'enum']);
const INPUT_TYPES: Record<string, string> = {
  integer: 'int', float: 'float', bool: 'bool', string: 'string', symbol: 'symbol', resolution: 'timeframe',
  session: 'session', source: 'source', time: 'time', color: 'color', price: 'price',
};
/** v4 input() arguments by position. */
const INPUT_POSITIONS = ['defval', 'title', 'type', 'minval', 'maxval', 'confirm', 'step', 'options'];
const SOURCES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']);
/** Where v4 took transp= and the colours it applies to (name, position). */
const TRANSP: Record<string, { readonly at: number; readonly colors: ReadonlyArray<readonly [string, number]> }> = {
  plot: { at: 5, colors: [['color', 2]] },
  plotshape: { at: 5, colors: [['color', 4]] },
  plotchar: { at: 5, colors: [['color', 4]] },
  plotarrow: { at: 4, colors: [['colorup', 2], ['colordown', 3]] },
  bgcolor: { at: 1, colors: [['color', 0]] },
  fill: { at: 3, colors: [['color', 2]] },
};
const ORDERS = new Set(['entry', 'order', 'exit', 'close', 'close_all', 'cancel', 'cancel_all']);
/** Where v4/v5 take `when` without its name, e.g. strategy.close("L", cond) (v6 has no `when` at all). */
const WHEN_POSITION: Record<string, number> = { close: 1, close_all: 0, cancel: 1, cancel_all: 0, entry: 8, order: 8 };

function inputType(defval: string | undefined): string | undefined {
  if (defval === undefined) return undefined;
  if (/^(true|false)$/.test(defval)) return 'bool';
  if (/^[-+]?\d+$/.test(defval)) return 'int';
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d+)$/.test(defval)) return 'float';
  if (/^(["']).*\1$/s.test(defval)) return 'string';
  if (SOURCES.has(defval)) return 'source';
  if (/^(color\.\w+|#[0-9a-fA-F]{6,8})$/.test(defval) || /^color\.(new|rgb)\s*\(/.test(defval)) return 'color';
  if (/^[-+*/%()\s\d.]+$/.test(defval) && /\d/.test(defval)) return /[./]/.test(defval) ? 'float' : 'int';
  return undefined;
}

const direction = (value: string) => value === 'true' ? 'strategy.long'
  : value === 'false' ? 'strategy.short'
    : /^strategy\.(long|short)$/.test(value) ? value : `(${value}) ? strategy.long : strategy.short`;

const snippet = (code: string) => {
  const line = code.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

class Converter {
  changes = 0;
  readonly notes: string[] = [];
  private readonly variables = new Set<string>();
  private readonly functions = new Set<string>();

  constructor(tokens: readonly Token[]) {
    // The script's own variables (declared outside any call) and functions (name(...) =>).
    let depth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.kind === 'op' && token.text === '(') depth += 1;
      else if (token.kind === 'op' && token.text === ')') depth = Math.max(0, depth - 1);
      if (token.kind !== 'id' || depth !== 0 || previousSignificant(tokens, index - 1)?.text === '.') continue;
      const next = nextSignificant(tokens, index + 1);
      if (tokens[next]?.text === '=') this.variables.add(token.text);
      if (tokens[next]?.text === '(') {
        const call = callArguments(tokens, next);
        if (call && tokens[nextSignificant(tokens, call.close + 1)]?.text === '=>') {
          this.functions.add(token.text);
          for (const arg of call.args) {
            const name = arg[nextSignificant(arg, 0)];
            if (name?.kind === 'id') this.variables.add(name.text);
          }
        }
      }
      if (previousSignificant(tokens, index - 1)?.text === '[' || previousSignificant(tokens, index - 1)?.text === ',') {
        // [a, b] = f(): a name in a tuple that is assigned
        let close = index;
        while (close < tokens.length && tokens[close]!.text !== ']' && tokens[close]!.kind !== 'nl') close += 1;
        if (tokens[close]?.text === ']' && tokens[nextSignificant(tokens, close + 1)]?.text === '=') this.variables.add(token.text);
      }
    }
  }

  convert(tokens: readonly Token[], depth: number): Token[] {
    const out: Token[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.kind === 'comment' && /^\/\/\s*@version\s*=\s*4\s*$/.test(token.text)) {
        out.push(raw(token.text.replace(/4(\s*)$/, '5$1'))); this.changes += 1; index += 1; continue;
      }
      if (token.kind !== 'id' || previousSignificant(tokens, index - 1)?.text === '.') { out.push(token); index += 1; continue; }
      let last = index;
      let name = token.text;
      while (tokens[last + 1]?.text === '.' && tokens[last + 2]?.kind === 'id') { name += `.${tokens[last + 2]!.text}`; last += 2; }
      let open = last + 1;
      while (tokens[open]?.kind === 'ws') open += 1;
      const call = tokens[open]?.text === '(' ? callArguments(tokens, open) : null;
      if (call) {
        if (tokens[nextSignificant(tokens, call.close + 1)]?.text === '=>') {
          out.push(...tokens.slice(index, call.close + 1)); index = call.close + 1; continue;
        }
        const args = call.args.map((arg) => this.convert(arg, depth + 1));
        out.push(...this.call(name, tokens.slice(last + 1, open), args));
        index = call.close + 1;
        continue;
      }
      const next = tokens[nextSignificant(tokens, last + 1)];
      const target = next?.text === '=' || next?.text === ':=';
      if (name === token.text && TAKEN_IN_V5.has(name) && this.variables.has(name) && !(target && depth > 0)) {
        out.push(raw(`${name}_`)); this.changes += 1;
      } else if (name === token.text && TA_VARIABLES.has(name) && !this.variables.has(name) && !target) {
        out.push(raw(`ta.${name}`)); this.changes += 1;
      } else out.push(...tokens.slice(index, last + 1));
      index = last + 1;
    }
    return out;
  }

  private call(name: string, gap: readonly Token[], given: Token[][]): Token[] {
    let args = given;
    let renamed = name;
    const emit = () => [raw(renamed), ...gap, raw('('), ...args.flatMap((arg, i) => (i ? [raw(','), ...arg] : arg)), raw(')')];
    const named = (label: string) => args.findIndex((arg) => argumentName(arg) === label);
    const positional = () => args.map((arg, i) => (argumentName(arg) === null ? i : -1)).filter((i) => i >= 0);
    const rename = (from: string, to: string) => {
      const at = named(from);
      if (at >= 0) { args[at] = withValue(args[at]!, argumentValue(args[at]!), to); this.changes += 1; }
    };
    if (this.functions.has(name)) return emit();

    if (name === 'iff' && args.length === 3) {
      this.changes += 1;
      return [raw(`(${argumentValue(args[0]!)} ? ${argumentValue(args[1]!)} : ${argumentValue(args[2]!)})`)];
    }
    if (name === 'offset' && args.length === 2) {
      this.changes += 1;
      return [raw(`(${argumentValue(args[0]!)})[${argumentValue(args[1]!)}]`)];
    }
    if (name === 'input') return this.input(gap, args);
    if (name === 'strategy.entry' || name === 'strategy.order') {
      const long = named('long');
      const at = long >= 0 ? long : positional()[1];
      if (at !== undefined) {
        const value = argumentValue(args[at]!);
        const next = direction(value);
        if (next !== value || long >= 0) { args[at] = withValue(args[at]!, next, long >= 0 ? 'direction' : undefined); this.changes += 1; }
      }
    }
    const transp = TRANSP[name];
    if (transp) args = this.transp(name, args, transp);
    if (name === 'security') {
      rename('resolution', 'timeframe');
      const pos = positional();
      for (const [label, at, on, off] of [['lookahead', pos[4], 'barmerge.lookahead_on', 'barmerge.lookahead_off'],
        ['gaps', pos[3], 'barmerge.gaps_on', 'barmerge.gaps_off']] as const) {
        const index = named(label) >= 0 ? named(label) : at;
        if (index === undefined) continue;
        const value = argumentValue(args[index]!);
        if (value === 'true' || value === 'false') { args[index] = withValue(args[index]!, value === 'true' ? on : off); this.changes += 1; }
      }
    }
    if (name === 'study') { rename('resolution', 'timeframe'); rename('resolution_gaps', 'timeframe_gaps'); }
    if (name === 'time' || name === 'time_close') rename('resolution', 'timeframe');
    if (RENAMED[name]) { renamed = RENAMED[name]!; this.changes += 1; }
    return emit();
  }

  private input(gap: readonly Token[], given: Token[][]): Token[] {
    // Every argument after the title gets its name: v5 has no type= and orders the rest differently.
    let args = given.map((arg, i) => (i >= 2 && argumentName(arg) === null && INPUT_POSITIONS[i]
      ? withValue(arg, argumentValue(arg), INPUT_POSITIONS[i]) : arg));
    let type: string | undefined;
    const typeAt = args.findIndex((arg) => argumentName(arg) === 'type');
    if (typeAt >= 0) {
      type = INPUT_TYPES[/^input\s*\.\s*(\w+)$/.exec(argumentValue(args[typeAt]!))?.[1] ?? ''];
      if (type) args = args.filter((_, i) => i !== typeAt);
    }
    const defvalAt = args.findIndex((arg) => argumentName(arg) === 'defval');
    const defval = defvalAt >= 0 ? args[defvalAt] : args.find((arg) => argumentName(arg) === null);
    type ??= inputType(defval && argumentValue(defval));
    const call = [raw(type ? `input.${type}` : 'input'), ...gap, raw('('), ...args.flatMap((arg, i) => (i ? [raw(','), ...arg] : arg)), raw(')')];
    if (type) this.changes += 1;
    else if (args.some((arg) => ['minval', 'maxval', 'step', 'options', 'type'].includes(argumentName(arg) ?? ''))) {
      this.notes.push(`input(): the type of its default value is not clear; choose input.int, input.float or another one: ${snippet(text(call))}`);
    }
    return call;
  }

  private transp(name: string, given: Token[][], spec: (typeof TRANSP)[string]): Token[][] {
    const positions = given.map((arg, i) => (argumentName(arg) === null ? i : -1)).filter((i) => i >= 0);
    const namedAt = given.findIndex((arg) => argumentName(arg) === 'transp');
    const at = namedAt >= 0 ? namedAt : positions[spec.at];
    if (at === undefined) return given;
    const value = argumentValue(given[at]!);
    const args = [...given];
    if (!/^0+(\.0*)?$/.test(value)) {
      let colored = false;
      for (const [label, position] of spec.colors) {
        const index = args.findIndex((arg) => argumentName(arg) === label);
        const colorAt = index >= 0 ? index : positions[position];
        if (colorAt === undefined) continue;
        args[colorAt] = withValue(args[colorAt]!, `color.new(${argumentValue(args[colorAt]!)}, ${value})`);
        colored = true;
      }
      if (!colored && name !== 'plotarrow') args.push([raw(` color=color.new(color.blue, ${value})`)]);
    }
    this.changes += 1;
    return args.filter((_, i) => i !== at);
  }
}

/** The strategy order call (strategy.entry, .exit, …) starting at `index` and its `when` argument (-1: none), or null. */
function orderCall(tokens: readonly Token[], index: number, version: number | null):
  { open: number; args: Token[][]; close: number; when: number } | null {
  const name = tokens[index + 2]?.text ?? '';
  if (tokens[index]?.text !== 'strategy' || tokens[index + 1]?.text !== '.' || !ORDERS.has(name)
    || previousSignificant(tokens, index - 1)?.text === '.') return null;
  let open = index + 3;
  while (tokens[open]?.kind === 'ws') open += 1;
  const call = tokens[open]?.text === '(' ? callArguments(tokens, open) : null;
  if (!call) return null;
  let when = call.args.findIndex((arg) => argumentName(arg) === 'when');
  const position = WHEN_POSITION[name];
  if (when < 0 && position !== undefined && version !== null && version <= 5) {
    const at = call.args.map((arg, i) => (argumentName(arg) === null ? i : -1)).filter((i) => i >= 0)[position];
    // A text there is a misplaced comment, not a condition.
    if (at !== undefined && !/^["']/.test(argumentValue(call.args[at]!))) when = at;
  }
  return { open, ...call, when };
}

/** Moves the `when` condition of statement-level strategy orders into an `if` (the engine here ignores `when`). */
function moveWhenIntoIf(source: string, version: number | null): { source: string; changes: number; notes: string[] } {
  const tokens = tokenize(source);
  const out: Token[] = [];
  const notes: string[] = [];
  let changes = 0;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const call = orderCall(tokens, index, version);
    const whenAt = call ? call.when : -1;
    if (!call || whenAt < 0) { out.push(token); index += 1; continue; }

    const lineStart = (() => { let i = out.length - 1; while (i >= 0 && out[i]!.kind === 'ws') i -= 1; return i; })();
    const startsLine = lineStart < 0 || out[lineStart]!.kind === 'nl';
    let end = call.close + 1;
    while (tokens[end]?.kind === 'ws') end += 1;
    const endsLine = end >= tokens.length || tokens[end]!.kind === 'nl' || tokens[end]!.kind === 'comment';
    const condition = argumentValue(call.args[whenAt]!).replace(/\s*\n\s*/g, ' ');
    const args = call.args.filter((_, i) => i !== whenAt);
    const callText = text([...tokens.slice(index, call.open), raw('('), ...args.flatMap((arg, i) => (i ? [raw(','), ...arg] : arg)), raw(')')]);
    if (!startsLine || !endsLine) {
      notes.push(`The order's condition could not be moved into an if here; put the order inside "if ${condition}": ${snippet(text(tokens.slice(index, call.close + 1)))}`);
      out.push(...tokens.slice(index, call.close + 1));
    } else if (condition === 'true') {
      out.push(raw(callText));
      changes += 1;
    } else {
      const indent = text(out.slice(lineStart + 1));
      const step = indent.includes('\t') ? '\t' : '    ';
      out.push(raw(`if ${condition}\n${indent}${step}${callText.replace(/\n/g, `\n${step}`)}`));
      changes += 1;
    }
    index = call.close + 1;
  }
  return { source: text(out), changes, notes };
}

export function pineVersion(source: string): number | null {
  const match = /^[ \t]*\/\/\s*@version\s*=\s*(\d+)\s*$/m.exec(source);
  return match ? Number(match[1]) : null;
}

/** Line of the first strategy order with a `when` condition (the engine here would ignore it), or null. */
export function pineWhenLine(source: string): number | null {
  const tokens = tokenize(source);
  const version = pineVersion(source);
  let line = 1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]!.kind === 'nl') { line += 1; continue; }
    if ((orderCall(tokens, index, version)?.when ?? -1) >= 0) return line;
  }
  return null;
}

/** What the editor can fix: Pine v4 (convert to v5) or order conditions (`when`) in v5/v6 code; null if nothing. */
export function pineFixAvailable(source: string): 'v4' | 'when' | null {
  const version = pineVersion(source);
  if (version === 4) return 'v4';
  return (version === 5 || version === 6) && pineWhenLine(source) !== null ? 'when' : null;
}

/** Pine v4 → v5 (and `when` into if); v5/v6 code only gets `when` moved into if. */
export function convertPineForService(source: string): PineConversion {
  let next = source;
  let changes = 0;
  const notes: string[] = [];
  if (pineVersion(source) === 4) {
    const tokens = tokenize(source);
    const converter = new Converter(tokens);
    next = text(converter.convert(tokens, 0));
    changes += converter.changes;
    notes.push(...converter.notes);
  }
  const moved = moveWhenIntoIf(next, pineVersion(next));
  return { source: moved.source, changes: changes + moved.changes, notes: [...notes, ...moved.notes] };
}
