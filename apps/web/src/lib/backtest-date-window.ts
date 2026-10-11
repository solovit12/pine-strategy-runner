const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

export function inclusiveUtcDays(start: string, end: string): number | null {
  const startMs = utcDay(start);
  const endMs = utcDay(end);
  if (startMs === null || endMs === null) return null;
  return Math.round((endMs - startMs) / DAY_MS) + 1;
}

export function backtestDateWindowError(start: string, end: string): string {
  const days = inclusiveUtcDays(start, end);
  if (days === null || days < 1) return 'Check the UTC start and end dates. / Проверьте начало и конец периода UTC.';
  return '';
}
