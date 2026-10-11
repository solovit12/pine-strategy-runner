/**
 * Exact decimal arithmetic for prices, quantities and money.
 *
 * The numeric value is `coefficient * 10^-scale`. Financial values never pass
 * through JavaScript Number; Number is used only for the bounded scale metadata.
 */

export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export type ExactDecimalRoundingMode = 'half-up';

export const MAX_EXACT_DECIMAL_SCALE = 4_096;
export const MAX_EXACT_DECIMAL_TEXT_LENGTH = 8_192;

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_POWER_OF_TEN_EXPONENT = MAX_EXACT_DECIMAL_SCALE * 2;

export const EXACT_DECIMAL_ZERO: ExactDecimal = Object.freeze({
  coefficient: 0n,
  scale: 0,
});

function checkedScale(value: number, label: string, maximum = MAX_EXACT_DECIMAL_SCALE): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be a non-negative safe integer not greater than ${maximum}.`);
  }
  return value;
}

function powerOfTen(exponent: number): bigint {
  checkedScale(exponent, 'power-of-ten exponent', MAX_POWER_OF_TEN_EXPONENT);
  return 10n ** BigInt(exponent);
}

function createExactDecimal(coefficient: bigint, scale: number): ExactDecimal {
  checkedScale(scale, 'decimal scale');
  if (coefficient === 0n) return EXACT_DECIMAL_ZERO;

  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  return Object.freeze({ coefficient: normalizedCoefficient, scale: normalizedScale });
}

function checkedDecimal(value: ExactDecimal, label: string): ExactDecimal {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${label} must be an ExactDecimal.`);
  }
  if (typeof value.coefficient !== 'bigint') {
    throw new TypeError(`${label}.coefficient must be a bigint.`);
  }
  checkedScale(value.scale, `${label}.scale`);
  return createExactDecimal(value.coefficient, value.scale);
}

function alignedCoefficient(value: ExactDecimal, targetScale: number): bigint {
  const decimal = checkedDecimal(value, 'decimal');
  checkedScale(targetScale, 'target scale');
  if (targetScale < decimal.scale) {
    throw new RangeError('target scale must not be smaller than the decimal scale.');
  }
  return decimal.coefficient * powerOfTen(targetScale - decimal.scale);
}

function alignedPair(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const checkedLeft = checkedDecimal(left, 'left');
  const checkedRight = checkedDecimal(right, 'right');
  const scale = Math.max(checkedLeft.scale, checkedRight.scale);
  return [
    alignedCoefficient(checkedLeft, scale),
    alignedCoefficient(checkedRight, scale),
    scale,
  ];
}

export function parseExactDecimal(value: string): ExactDecimal {
  if (typeof value !== 'string') throw new TypeError('decimal value must be a string.');
  if (value.length === 0 || value.length > MAX_EXACT_DECIMAL_TEXT_LENGTH || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError('decimal value must be a canonical decimal string without exponent notation.');
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const point = unsigned.indexOf('.');
  const integer = point === -1 ? unsigned : unsigned.slice(0, point);
  const fraction = point === -1 ? '' : unsigned.slice(point + 1);
  checkedScale(fraction.length, 'decimal scale');

  const digits = `${integer}${fraction}`;
  const coefficient = BigInt(digits);
  return createExactDecimal(negative ? -coefficient : coefficient, fraction.length);
}

export function formatExactDecimal(value: ExactDecimal): string {
  const decimal = checkedDecimal(value, 'decimal');
  if (decimal.coefficient === 0n) return '0';

  const negative = decimal.coefficient < 0n;
  const digits = (negative ? -decimal.coefficient : decimal.coefficient).toString();
  if (decimal.scale === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(decimal.scale + 1, '0');
  const splitAt = padded.length - decimal.scale;
  return `${negative ? '-' : ''}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

export function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): -1 | 0 | 1 {
  const [leftCoefficient, rightCoefficient] = alignedPair(left, right);
  if (leftCoefficient === rightCoefficient) return 0;
  return leftCoefficient < rightCoefficient ? -1 : 1;
}

export function addExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [leftCoefficient, rightCoefficient, scale] = alignedPair(left, right);
  return createExactDecimal(leftCoefficient + rightCoefficient, scale);
}

export function subtractExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [leftCoefficient, rightCoefficient, scale] = alignedPair(left, right);
  return createExactDecimal(leftCoefficient - rightCoefficient, scale);
}

export function multiplyExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const checkedLeft = checkedDecimal(left, 'left');
  const checkedRight = checkedDecimal(right, 'right');
  const scale = checkedLeft.scale + checkedRight.scale;
  checkedScale(scale, 'product scale');
  return createExactDecimal(checkedLeft.coefficient * checkedRight.coefficient, scale);
}

/**
 * Divide and round to `outputScale`. A half tie is rounded away from zero,
 * matching decimal ROUND_HALF_UP for both positive and negative values.
 */
export function divideExactDecimalsToScale(
  dividend: ExactDecimal,
  divisor: ExactDecimal,
  outputScale: number,
  roundingMode: ExactDecimalRoundingMode,
): ExactDecimal {
  const checkedDividend = checkedDecimal(dividend, 'dividend');
  const checkedDivisor = checkedDecimal(divisor, 'divisor');
  checkedScale(outputScale, 'output scale');
  if (roundingMode !== 'half-up') throw new RangeError('Only half-up rounding is supported.');
  if (checkedDivisor.coefficient === 0n) throw new RangeError('Cannot divide by zero.');
  if (checkedDividend.coefficient === 0n) return EXACT_DECIMAL_ZERO;

  const negative = (checkedDividend.coefficient < 0n) !== (checkedDivisor.coefficient < 0n);
  let numerator = checkedDividend.coefficient < 0n
    ? -checkedDividend.coefficient
    : checkedDividend.coefficient;
  let denominator = checkedDivisor.coefficient < 0n
    ? -checkedDivisor.coefficient
    : checkedDivisor.coefficient;

  const scaleShift = outputScale + checkedDivisor.scale - checkedDividend.scale;
  if (scaleShift >= 0) numerator *= powerOfTen(scaleShift);
  else denominator *= powerOfTen(-scaleShift);

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;

  return createExactDecimal(negative ? -quotient : quotient, outputScale);
}

export function minExactDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const checkedLeft = checkedDecimal(left, 'left');
  const checkedRight = checkedDecimal(right, 'right');
  return compareExactDecimals(checkedLeft, checkedRight) <= 0 ? checkedLeft : checkedRight;
}

export function isExactMultipleOfStep(value: ExactDecimal, step: ExactDecimal): boolean {
  const checkedValue = checkedDecimal(value, 'value');
  const checkedStep = checkedDecimal(step, 'step');
  if (checkedStep.coefficient <= 0n) throw new RangeError('step must be greater than zero.');

  const scale = Math.max(checkedValue.scale, checkedStep.scale);
  const valueCoefficient = alignedCoefficient(checkedValue, scale);
  const stepCoefficient = alignedCoefficient(checkedStep, scale);
  return valueCoefficient % stepCoefficient === 0n;
}

export function assertExactMultipleOfStep(value: ExactDecimal, step: ExactDecimal): void {
  if (!isExactMultipleOfStep(value, step)) {
    throw new RangeError(
      `${formatExactDecimal(value)} is not an exact multiple of step ${formatExactDecimal(step)}.`,
    );
  }
}
