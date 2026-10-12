import { pineToJS } from 'pinets';

/**
 * Plain-language messages for mistakes in Pine code, with the line they are on. The engine's
 * own texts ("Expected INDENT but got IDENTIFIER at 4:13", "foo is not defined") name the
 * place where parsing failed, which for a missing bracket is lines after the real mistake.
 * Messages are "English / Русский", as elsewhere on the site.
 */
export class PineCodeError extends Error {
  readonly kind = 'compile' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PineCodeError';
  }
}

type Position = { line: number; column: number };

const PAIRS: Record<string, string> = { '(': ')', '[': ']' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[' };

/** A bracket opened and never closed, or closed without being opened (strings and comments skipped). */
export function unbalancedBracket(source: string): (Position & { char: string; problem: 'unclosed' | 'extra' }) | null {
  const open: Array<Position & { char: string }> = [];
  let line = 1;
  let column = 0;
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    column += 1;
    if (char === '\n') {
      line += 1;
      column = 0;
      quote = null; // a Pine string ends with its line; the engine reports that separately
      continue;
    }
    if (quote) {
      if (char === '\\') { index += 1; column += 1; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      if (end < 0) break;
      column += end - index - 1;
      index = end - 1;
      continue;
    }
    if (PAIRS[char]) open.push({ char, line, column });
    else if (CLOSERS[char]) {
      if (open.at(-1)?.char === CLOSERS[char]) open.pop();
      else if (open.length === 0) return { char, line, column, problem: 'extra' };
      else return { ...open.at(-1)!, problem: 'unclosed' };
    }
  }
  return open.length > 0 ? { ...open.at(-1)!, problem: 'unclosed' } : null;
}

function codeLine(source: string, line: number): string {
  const text = (source.split('\n')[line - 1] ?? '').trim();
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function onLine(source: string, line: number, en: string, ru: string): string {
  const code = codeLine(source, line);
  return `Line ${line}: ${en}${code ? ` Code: ${code}` : ''} / Строка ${line}: ${ru}`;
}

/** Explains why the engine cannot read the code, or returns null when it can. */
export function pineSyntaxError(source: string): PineCodeError | null {
  const parsed = pineToJS(source) as { success: boolean; error?: string; version?: number | null };
  if (parsed.success) return null;
  const engine = String(parsed.error ?? '');
  if (parsed.version === null || parsed.version === undefined) {
    return new PineCodeError('Add the Pine version as the first line, for example //@version=6. / '
      + 'Добавьте версию Pine первой строкой, например //@version=6.');
  }
  if (parsed.version < 5) {
    return new PineCodeError(`Pine v${parsed.version} is not supported; convert the script to v5 or v6 (TradingView can convert it in the Pine Editor). / `
      + `Pine v${parsed.version} не поддерживается; переведите скрипт на v5 или v6 (TradingView умеет это в Pine Editor).`);
  }
  const string = /Unterminated (?:multiline )?string at (\d+):/.exec(engine);
  if (string) {
    const line = Number(string[1]);
    return new PineCodeError(onLine(source, line, 'a text in quotes is not closed; add the closing quote.',
      'текст в кавычках не закрыт; добавьте закрывающую кавычку.'));
  }
  const bracket = unbalancedBracket(source);
  if (bracket) {
    const closer = PAIRS[bracket.char] ?? bracket.char;
    return new PineCodeError(bracket.problem === 'unclosed'
      ? onLine(source, bracket.line, `the bracket "${bracket.char}" opened here is never closed; add "${closer}".`,
        `скобка «${bracket.char}» открыта и не закрыта; добавьте «${closer}».`)
      : onLine(source, bracket.line, `the bracket "${bracket.char}" has no opening pair; remove it or add "${CLOSERS[bracket.char]}" before it.`,
        `у скобки «${bracket.char}» нет открывающей пары; удалите её или добавьте «${CLOSERS[bracket.char]}» перед ней.`));
  }
  const at = /at (\d+):(\d+)/.exec(engine);
  const line = at ? Number(at[1]) : null;
  if (line !== null && /Indentation error|INDENT|DEDENT/.test(engine)) {
    return new PineCodeError(onLine(source, line,
      'wrong indentation. Lines inside if, for, while or a function start with 4 spaces (or one tab) more than the line that opens them.',
      'неверный отступ. Строки внутри if, for, while или функции начинаются на 4 пробела (или один Tab) правее строки, которая их открывает.'));
  }
  const character = /Unexpected character '(.)' at (\d+):/.exec(engine);
  if (character) {
    return new PineCodeError(onLine(source, Number(character[2]), `the character "${character[1]}" is not allowed here.`,
      `символ «${character[1]}» здесь недопустим.`));
  }
  const detail = engine.replace(/\s*at \d+:\d+.*$/s, '');
  if (line !== null && /EOF/.test(engine)) {
    return new PineCodeError(onLine(source, line,
      'the code ends before a line above is finished (for example "if close >" with nothing after ">").',
      'код закончился раньше, чем дописана строка выше (например «if close >» без продолжения после «>»).'));
  }
  return new PineCodeError(line !== null
    ? onLine(source, line, `the code cannot be read here or on the line above (${detail}).`,
      `код не читается в этой строке или строкой выше (${detail}).`)
    : `The Pine code cannot be read: ${engine} / Код Pine не читается: ${engine}`);
}

/** The script must declare a strategy: backtests and Paper trade its orders. */
export function pineDeclarationError(source: string): PineCodeError | null {
  const code = source.replace(/\/\/.*$/gm, '');
  if (/^\s*strategy\s*\(/m.test(code)) return null;
  return new PineCodeError(/^\s*indicator\s*\(/m.test(code)
    ? 'This script is an indicator: it declares indicator(...) and places no orders. Backtests and Paper need a strategy, declared with strategy(...). / '
      + 'Этот скрипт — индикатор: в нём indicator(...), и он не выставляет заявок. Для бэктеста и Paper нужна стратегия, объявленная через strategy(...).'
    : 'The script has no strategy(...) line. Add one after //@version, for example strategy("My strategy", overlay=true). / '
      + 'В скрипте нет строки strategy(...). Добавьте её после //@version, например strategy("My strategy", overlay=true).');
}

/** The first mistake that stops the code from running as a strategy, or null. */
export function pineCodeError(source: string): PineCodeError | null {
  return pineSyntaxError(source) ?? pineDeclarationError(source);
}

/** First line where `pattern` appears outside comments, or null. */
function lineOf(source: string, pattern: RegExp): number | null {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const code = lines[index]!.replace(/\/\/.*$/, '');
    if (pattern.test(code)) return index + 1;
  }
  return null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plain message for a run-time mistake in the code (unknown function or name), or null. */
export function explainPineRuntimeError(error: unknown, source: string): PineCodeError | null {
  const message = error instanceof Error ? error.message : String(error);
  const fn = /^([A-Za-z_][\w.]*) is not a function$/.exec(message);
  if (fn) {
    const name = fn[1]!;
    const line = lineOf(source, new RegExp(`(^|[^\\w.])${escape(name)}\\s*\\(`));
    const en = `"${name}" is not a Pine function this engine knows. Check the spelling${name.startsWith('strategy.') ? ' (for example strategy.entry, strategy.exit, strategy.close)' : ''}.`;
    const ru = `«${name}» — не функция Pine, известная движку. Проверьте написание${name.startsWith('strategy.') ? ' (например strategy.entry, strategy.exit, strategy.close)' : ''}.`;
    return new PineCodeError(line ? onLine(source, line, en, ru) : `${en} / ${ru}`);
  }
  const name = /^([A-Za-z_]\w*) is not defined$/.exec(message)?.[1];
  if (name) {
    const line = lineOf(source, new RegExp(`(^|[^\\w.])${escape(name)}(?![\\w])`));
    const en = `"${name}" is used but never defined. Check the spelling, or define it first (${name} = ...).`;
    const ru = `«${name}» используется, но нигде не задано. Проверьте написание или задайте его раньше (${name} = ...).`;
    return new PineCodeError(line ? onLine(source, line, en, ru) : `${en} / ${ru}`);
  }
  return null;
}
