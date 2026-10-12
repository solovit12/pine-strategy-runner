import { describe, expect, it } from 'vitest';
import { explainPineRuntimeError, pineCodeError, unbalancedBracket } from '../packages/pine-runtime/src/pine-errors';

const v6 = (body: string) => `//@version=6\n${body}`;
const entry = '\nif close > open\n    strategy.entry("L", strategy.long)';

describe('Plain messages for Pine code mistakes', () => {
  it('accepts correct code', () => {
    expect(pineCodeError(v6(`strategy("X", overlay=true)${entry}`))).toBeNull();
  });

  it('points at the bracket that is never closed, not at the line where parsing failed', () => {
    const error = pineCodeError(v6(`strategy("X", overlay=true, initial_capital=1000${entry}`));
    expect(error?.kind).toBe('compile');
    expect(error?.message).toBe('Line 2: the bracket "(" opened here is never closed; add ")". Code: strategy("X", overlay=true, initial_capital=1000 / '
      + 'Строка 2: скобка «(» открыта и не закрыта; добавьте «)».');
    expect(pineCodeError(v6(`strategy("X")\nma = ta.sma(close, 14${entry}`))?.message).toMatch(/^Line 3: the bracket "\(" opened here/);
  });

  it('points at an extra closing bracket', () => {
    expect(pineCodeError(v6(`strategy("X"))${entry}`))?.message).toMatch(/^Line 2: the bracket "\)" has no opening pair/);
  });

  it('ignores brackets inside strings and comments', () => {
    expect(unbalancedBracket('strategy("a (b") // (\nx = [1, 2]')).toBeNull();
  });

  it('explains an unclosed quote, a wrong indent and an unfinished line', () => {
    expect(pineCodeError(v6(`strategy("X)${entry}`))?.message).toMatch(/^Line 2: a text in quotes is not closed/);
    expect(pineCodeError(v6(`strategy("X")\nif close > open\n        strategy.entry("L", strategy.long)`))?.message).toMatch(/^Line 4: wrong indentation/);
    expect(pineCodeError(v6(`strategy("X")\nif close >\n    strategy.entry("L", strategy.long)`))?.message).toMatch(/^Line 4: the code ends before a line above is finished/);
  });

  it('asks for the version line and a strategy declaration', () => {
    expect(pineCodeError(`strategy("X")${entry}`)?.message).toMatch(/^Add the Pine version as the first line/);
    expect(pineCodeError(v6('indicator("X")\nplot(close)'))?.message).toMatch(/^This script is an indicator/);
    expect(pineCodeError(v6('plot(close)'))?.message).toMatch(/^The script has no strategy\(\.\.\.\) line/);
  });

  it('names the line of an unknown function or name found while running', () => {
    const source = v6(`strategy("X")\nma = ta.smaa(close, 14)\nif close > foo\n    strategy.entri("L", strategy.long)`);
    expect(explainPineRuntimeError(new TypeError('ta.smaa is not a function'), source)?.message)
      .toMatch(/^Line 3: "ta\.smaa" is not a Pine function this engine knows\. Check the spelling\. Code: ma = ta\.smaa\(close, 14\) \/ Строка 3:/);
    expect(explainPineRuntimeError(new TypeError('strategy.entri is not a function'), source)?.message)
      .toMatch(/^Line 5: "strategy\.entri" .*strategy\.entry, strategy\.exit/);
    expect(explainPineRuntimeError(new ReferenceError('foo is not defined'), source)?.message)
      .toMatch(/^Line 4: "foo" is used but never defined/);
    expect(explainPineRuntimeError(new Error('Something else'), source)).toBeNull();
  });
});
