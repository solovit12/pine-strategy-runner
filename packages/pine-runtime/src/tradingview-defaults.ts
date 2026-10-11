export interface TradingViewStrategyDefaults {
  pineVersion: 5 | 6 | null;
  marginLongPercent?: number;
  marginShortPercent?: number;
  legacyMarginDefaultsApplied: boolean;
}

function maskCommentsAndStrings(source: string): string {
  let result = '';
  let index = 0;
  let quote: '"' | "'" | null = null;
  let lineComment = false;
  let blockComment = false;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];

    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        result += '\n';
      } else {
        result += ' ';
      }
      index += 1;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        result += '  ';
        index += 2;
        blockComment = false;
      } else {
        result += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\' && next !== undefined) {
        result += '  ';
        index += 2;
      } else if (current === quote) {
        result += ' ';
        index += 1;
        quote = null;
      } else {
        result += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      result += '  ';
      index += 2;
      lineComment = true;
      continue;
    }
    if (current === '/' && next === '*') {
      result += '  ';
      index += 2;
      blockComment = true;
      continue;
    }
    if (current === '"' || current === "'") {
      result += ' ';
      index += 1;
      quote = current;
      continue;
    }
    result += current;
    index += 1;
  }

  return result;
}

function strategyDeclarationArguments(source: string): string {
  const masked = maskCommentsAndStrings(source);
  const declaration = /\bstrategy\s*\(/g.exec(masked);
  if (!declaration) return '';

  const openParenthesis = masked.indexOf('(', declaration.index);
  let depth = 0;
  for (let index = openParenthesis; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1;
    if (masked[index] === ')') {
      depth -= 1;
      if (depth === 0) return masked.slice(openParenthesis + 1, index);
    }
  }
  return '';
}

export function tradingViewStrategyDefaults(source: string): TradingViewStrategyDefaults {
  const versionMatch = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(5|6)\b/m.exec(source);
  const pineVersion = versionMatch ? Number(versionMatch[1]) as 5 | 6 : null;
  const argumentsText = strategyDeclarationArguments(source);
  const hasMarginLong = /\bmargin_long\s*=/.test(argumentsText);
  const hasMarginShort = /\bmargin_short\s*=/.test(argumentsText);

  // TradingView keeps the legacy Pine v5 defaults at 0% margin (unlimited
  // leverage). PineTS 0.9.33 otherwise injects the Pine v6 default of 100%.
  const marginLongPercent = pineVersion === 5 && !hasMarginLong ? 0 : undefined;
  const marginShortPercent = pineVersion === 5 && !hasMarginShort ? 0 : undefined;
  return {
    pineVersion,
    marginLongPercent,
    marginShortPercent,
    legacyMarginDefaultsApplied: marginLongPercent !== undefined || marginShortPercent !== undefined,
  };
}
