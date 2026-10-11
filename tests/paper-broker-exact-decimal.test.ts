import { describe, expect, it } from 'vitest';

import {
  EXACT_DECIMAL_ZERO,
  addExactDecimals,
  assertExactMultipleOfStep,
  compareExactDecimals,
  divideExactDecimalsToScale,
  formatExactDecimal,
  isExactMultipleOfStep,
  minExactDecimal,
  multiplyExactDecimals,
  parseExactDecimal,
  subtractExactDecimals,
} from '../packages/shared/src/exact-decimal.js';

const decimal = parseExactDecimal;
const text = formatExactDecimal;

describe('Paper Broker exact decimal foundation', () => {
  it('parses, normalizes and formats signed canonical decimal strings', () => {
    expect(decimal('123.4500')).toEqual({ coefficient: 12345n, scale: 2 });
    expect(decimal('-0.001200')).toEqual({ coefficient: -12n, scale: 4 });
    expect(decimal('-42')).toEqual({ coefficient: -42n, scale: 0 });
    expect(decimal('-0.000')).toBe(EXACT_DECIMAL_ZERO);
    expect(text(decimal('123.4500'))).toBe('123.45');
    expect(text(decimal('-0.001200'))).toBe('-0.0012');
    expect(text(EXACT_DECIMAL_ZERO)).toBe('0');
  });

  it('rejects non-canonical or non-string input', () => {
    for (const invalid of ['', ' ', '+1', '.5', '1.', '01', '-01', '1e3', '1E3', '1,000', 'NaN', 'Infinity']) {
      expect(() => decimal(invalid), invalid).toThrow(TypeError);
    }
    expect(() => decimal(1 as unknown as string)).toThrow(TypeError);
  });

  it('compares, adds and subtracts values with different scales exactly', () => {
    expect(compareExactDecimals(decimal('1.20'), decimal('1.2'))).toBe(0);
    expect(compareExactDecimals(decimal('-1.21'), decimal('-1.2'))).toBe(-1);
    expect(compareExactDecimals(decimal('0.0001'), decimal('0'))).toBe(1);

    expect(text(addExactDecimals(decimal('1.2'), decimal('0.03')))).toBe('1.23');
    expect(text(addExactDecimals(decimal('-1.2'), decimal('0.2')))).toBe('-1');
    expect(text(subtractExactDecimals(decimal('1'), decimal('1.0001')))).toBe('-0.0001');
    expect(text(subtractExactDecimals(decimal('-5'), decimal('-7.25')))).toBe('2.25');
  });

  it('keeps precision far beyond Number safe-integer bounds', () => {
    const huge = '99999999999999999999999999999999999999999999999999999999999999999999999999999999';
    expect(text(addExactDecimals(decimal(huge), decimal('1')))).toBe(
      '100000000000000000000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(text(subtractExactDecimals(decimal(`${huge}.00000000000000000001`), decimal(huge)))).toBe(
      '0.00000000000000000001',
    );
  });

  it('multiplies signed prices, quantities and rates without floating-point conversion', () => {
    expect(text(multiplyExactDecimals(decimal('12345678901234567890.12345'), decimal('0.00001')))).toBe(
      '123456789012345.6789012345',
    );
    expect(text(multiplyExactDecimals(decimal('-1.25'), decimal('0.08')))).toBe('-0.1');
    expect(multiplyExactDecimals(decimal('99999999999999999999'), decimal('99999999999999999999')))
      .toEqual({ coefficient: 9999999999999999999800000000000000000001n, scale: 0 });
  });

  it('divides to an explicit scale with half-up rounding away from zero on ties', () => {
    expect(text(divideExactDecimalsToScale(decimal('1'), decimal('8'), 2, 'half-up'))).toBe('0.13');
    expect(text(divideExactDecimalsToScale(decimal('-1'), decimal('8'), 2, 'half-up'))).toBe('-0.13');
    expect(text(divideExactDecimalsToScale(decimal('5'), decimal('2'), 0, 'half-up'))).toBe('3');
    expect(text(divideExactDecimalsToScale(decimal('-5'), decimal('2'), 0, 'half-up'))).toBe('-3');
    expect(text(divideExactDecimalsToScale(decimal('1'), decimal('6'), 3, 'half-up'))).toBe('0.167');
    expect(text(divideExactDecimalsToScale(decimal('2'), decimal('3'), 10, 'half-up'))).toBe('0.6666666667');
    expect(text(divideExactDecimalsToScale(decimal('1.2'), decimal('0.03'), 0, 'half-up'))).toBe('40');
    expect(() => divideExactDecimalsToScale(decimal('1'), EXACT_DECIMAL_ZERO, 2, 'half-up')).toThrow(
      'Cannot divide by zero',
    );
    expect(() => divideExactDecimalsToScale(decimal('1'), decimal('2'), -1, 'half-up')).toThrow(RangeError);
  });

  it('returns the exact minimum across signs and scales', () => {
    expect(text(minExactDecimal(decimal('1.200'), decimal('1.19')))).toBe('1.19');
    expect(text(minExactDecimal(decimal('-1.2'), decimal('-1.19')))).toBe('-1.2');
    expect(text(minExactDecimal(decimal('0'), decimal('0.000')))).toBe('0');
  });

  it('validates exact quantity and tick-size multiples after scale alignment', () => {
    expect(isExactMultipleOfStep(decimal('1.25'), decimal('0.05'))).toBe(true);
    expect(isExactMultipleOfStep(decimal('1.2500'), decimal('0.010'))).toBe(true);
    expect(isExactMultipleOfStep(decimal('1.26'), decimal('0.05'))).toBe(false);
    expect(isExactMultipleOfStep(decimal('-1.25'), decimal('0.05'))).toBe(true);
    expect(isExactMultipleOfStep(EXACT_DECIMAL_ZERO, decimal('0.05'))).toBe(true);
    expect(() => assertExactMultipleOfStep(decimal('2.5'), decimal('0.5'))).not.toThrow();
    expect(() => assertExactMultipleOfStep(decimal('2.51'), decimal('0.5'))).toThrow(
      '2.51 is not an exact multiple of step 0.5',
    );
    expect(() => isExactMultipleOfStep(decimal('1'), decimal('0'))).toThrow('step must be greater than zero');
    expect(() => isExactMultipleOfStep(decimal('1'), decimal('-0.1'))).toThrow('step must be greater than zero');
  });

  it('rejects malformed ExactDecimal objects instead of coercing them', () => {
    expect(() => text({ coefficient: 1 as unknown as bigint, scale: 0 })).toThrow(TypeError);
    expect(() => text({ coefficient: 1n, scale: 0.5 })).toThrow(RangeError);
    expect(() => text(null as unknown as Parameters<typeof text>[0])).toThrow(TypeError);
  });
});
