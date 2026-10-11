import { useId, type ReactNode } from 'react';

interface TranslatedTextProps {
  en: ReactNode;
  ru: ReactNode;
  block?: boolean;
  className?: string;
  focusable?: boolean;
}

export function TranslatedText({ en, ru, block = false, className = '', focusable = true }: TranslatedTextProps) {
  const tooltipId = useId();
  const classes = ['translated-text', block ? 'translated-text-block' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} aria-describedby={tooltipId} tabIndex={focusable ? 0 : undefined}>
      {en}
      <span id={tooltipId} className="translation-tooltip" role="tooltip" lang="ru">{ru}</span>
    </span>
  );
}

interface InfoTooltipProps {
  en: ReactNode;
  ru: ReactNode;
  label: string;
  alignRight?: boolean;
}

export function InfoTooltip({ en, ru, label, alignRight = false }: InfoTooltipProps) {
  const tooltipId = useId();

  return (
    <span
      className={`info-help${alignRight ? ' info-help-right' : ''}`}
      role="img"
      tabIndex={0}
      aria-label={`Information about ${label}`}
      aria-describedby={tooltipId}
    >
      ⓘ
      <span id={tooltipId} className="info-help-tooltip" role="tooltip">
        <span lang="en">{en}</span>
        <span lang="ru">{ru}</span>
      </span>
    </span>
  );
}
