export class UnsupportedPineFeatureError extends Error {
  readonly kind = 'unsupported-feature' as const;

  constructor(feature: string) {
    super(`${feature} пока не поддерживается: запуск остановлен, чтобы не подставить данные текущего графика вместо запрошенной серии.`);
    this.name = 'UnsupportedPineFeatureError';
  }
}

function executableSource(source: string): string {
  return source
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\/\/.*$/gm, '');
}

export function assertNoUnsupportedExternalSeries(source: string): void {
  const executable = executableSource(source);
  const match = executable.match(/\brequest\s*\.\s*(security(?:_lower_tf)?)\s*\(/m);
  if (match) throw new UnsupportedPineFeatureError(`request.${match[1]}`);
}
