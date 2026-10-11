import { describe, expect, it } from 'vitest';
import { backtestDateWindowError, inclusiveUtcDays } from '../apps/web/src/lib/backtest-date-window';

describe('backtest UI date window', () => {
  it('counts both selected UTC dates, including a leap day', () => {
    expect(inclusiveUtcDays('2024-02-28', '2024-03-01')).toBe(3);
  });

  it('accepts long historical windows without an arbitrary UI day limit', () => {
    expect(inclusiveUtcDays('2024-01-01', '2025-12-31')).toBe(731);
    expect(backtestDateWindowError('2024-01-01', '2025-12-31')).toBe('');
  });

  it('rejects an inverted or invalid date range', () => {
    expect(backtestDateWindowError('2025-03-02', '2025-03-01')).toBeTruthy();
    expect(backtestDateWindowError('2025-02-30', '2025-03-01')).toBeTruthy();
    expect(backtestDateWindowError('', '2025-03-01')).toContain('Check the UTC start and end dates');
  });
});
