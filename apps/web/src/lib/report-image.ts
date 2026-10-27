import type { BacktestReport } from '../../../../packages/shared/src/report-contracts';
import { conditionsText, periodDays, ruDate, signed } from './backtest-report';

/** The picture for the Telegram post: 1080×1350 (fills a phone screen), the app's dark colors, Russian. */
export const REPORT_IMAGE_SIZE = { width: 1080, height: 1350 } as const;

const C = {
  bg: '#080b0c', panel: '#101416', line: '#20282b', text: '#e5e9eb', muted: '#8d999e', green: '#63dda5', red: '#ff7476',
  brandBorder: '#496257', brandBg: '#101b16',
};
const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = '"Cascadia Code", "SF Mono", Menlo, Consolas, monospace';
const PAD = 72;

const number = (value: number, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);

/** Lines that fit the width, at most `maxLines`, the last one cut with "…" when the text is longer. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= width || !current) { current = next; continue; }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines.map((line) => fit(ctx, line, width));
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(ctx, `${kept[maxLines - 1]} ${lines[maxLines]}`, width, true);
  return kept;
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number, forceEllipsis = false): string {
  if (!forceEllipsis && ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function font(ctx: CanvasRenderingContext2D, size: number, weight = 400, family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
}

function shortLink(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

function drawEquity(ctx: CanvasRenderingContext2D, points: readonly { time: number; equity: number }[], initial: number, x: number, y: number,
  width: number, height: number, currency: string) {
  ctx.fillStyle = C.panel;
  ctx.fillRect(x, y, width, height);
  font(ctx, 22, 700, MONO);
  ctx.fillStyle = C.muted;
  ctx.textBaseline = 'top';
  ctx.fillText('КРИВАЯ КАПИТАЛА', x + 24, y + 22);
  const top = y + 70;
  const bottom = y + height - 52;
  const left = x + 24;
  const right = x + width - 24;
  const values = points.map((point) => point.equity).concat(initial);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const margin = (max - min) * 0.08;
  min -= margin; max += margin;
  const t0 = points[0]!.time;
  const t1 = Math.max(points.at(-1)!.time, t0 + 1);
  const px = (time: number) => left + ((time - t0) / (t1 - t0)) * (right - left);
  const py = (equity: number) => bottom - ((equity - min) / (max - min)) * (bottom - top);
  const color = points.at(-1)!.equity >= initial ? C.green : C.red;

  // The starting capital, dashed.
  ctx.strokeStyle = '#3a4549';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(left, py(initial));
  ctx.lineTo(right, py(initial));
  ctx.stroke();
  ctx.setLineDash([]);

  // The account steps at each closed trade.
  const path = new Path2D();
  points.forEach((point, index) => {
    if (index === 0) path.moveTo(px(point.time), py(point.equity));
    else { path.lineTo(px(point.time), py(points[index - 1]!.equity)); path.lineTo(px(point.time), py(point.equity)); }
  });
  const area = new Path2D(path);
  area.lineTo(px(points.at(-1)!.time), bottom);
  area.lineTo(px(t0), bottom);
  area.closePath();
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, `${color}55`);
  gradient.addColorStop(1, `${color}00`);
  ctx.fillStyle = gradient;
  ctx.fill(area);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.stroke(path);

  font(ctx, 20, 400, MONO);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  ctx.fillText(`${number(max - margin, 0)} ${currency}`, right, y + 24);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const dateText = (time: number) => ruDate(new Date(time).toISOString());
  ctx.fillText(dateText(t0), left, y + height - 16);
  ctx.textAlign = 'right';
  ctx.fillText(dateText(points.at(-1)!.time), right, y + height - 16);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** Draws the report onto the canvas (resized to the picture's size). */
export function drawReportImage(canvas: HTMLCanvasElement, report: BacktestReport, equity: readonly { time: number; equity: number }[]): void {
  canvas.width = REPORT_IMAGE_SIZE.width;
  canvas.height = REPORT_IMAGE_SIZE.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw pictures.');
  const W = canvas.width;
  const H = canvas.height;
  const inner = W - PAD * 2;
  const m = report.metrics;
  const profitColor = m.totalProfit >= 0 ? C.green : C.red;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Brand.
  ctx.fillStyle = C.brandBg;
  ctx.fillRect(PAD, PAD, 56, 56);
  ctx.strokeStyle = C.brandBorder;
  ctx.lineWidth = 2;
  ctx.strokeRect(PAD + 1, PAD + 1, 54, 54);
  font(ctx, 32, 800);
  ctx.fillStyle = C.green;
  ctx.textAlign = 'center';
  ctx.fillText('S', PAD + 28, PAD + 11);
  ctx.textAlign = 'left';
  font(ctx, 30, 800);
  ctx.fillStyle = C.text;
  ctx.fillText('SVIT RUNNER', PAD + 76, PAD + 13);
  font(ctx, 22, 700, MONO);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  ctx.fillText('БЭКТЕСТ', W - PAD, PAD + 18);
  ctx.textAlign = 'left';

  // Strategy, market and period.
  let y = PAD + 56 + 48;
  font(ctx, 56, 800);
  ctx.fillStyle = C.text;
  for (const line of wrap(ctx, report.strategyName, inner, 2)) { ctx.fillText(line, PAD, y); y += 66; }
  y += 8;
  font(ctx, 28, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(fit(ctx, `${report.symbol} · ${report.timeframe} · ${report.dataSource}`, inner), PAD, y);
  y += 40;
  ctx.fillText(`${ruDate(report.dateRange.start)} — ${ruDate(report.dateRange.end)} · ${periodDays(report)} дн.`, PAD, y);
  y += 64;

  // The result.
  font(ctx, 22, 700, MONO);
  ctx.fillText('ИТОГ', PAD, y);
  y += 34;
  font(ctx, 112, 800);
  ctx.fillStyle = profitColor;
  const percent = `${signed(m.totalProfitPercent)} %`;
  ctx.fillText(percent, PAD, y);
  const percentWidth = ctx.measureText(percent).width;
  font(ctx, 36, 600);
  ctx.fillStyle = C.text;
  ctx.fillText(fit(ctx, `${signed(m.totalProfit)} ${report.currency}`, inner - percentWidth - 36), PAD + percentWidth + 36, y + 62);
  y += 140;

  // Six numbers.
  const cells: [string, string][] = [
    ['СДЕЛОК', number(m.totalTrades, 0)],
    ['ПРИБЫЛЬНЫХ', `${number(m.winRatePercent, 1)} %`],
    ['PROFIT FACTOR', m.profitFactor === null ? '—' : number(m.profitFactor)],
    ['МАКС. ПРОСАДКА', `${number(m.maxDrawdownPercent)} %`],
    ['СРЕДНЯЯ СДЕЛКА', `${signed(m.averageTrade)} ${report.currency}`],
    ['ЛОНГ / ШОРТ', `${m.longTrades} / ${m.shortTrades}`],
  ];
  const gap = 8;
  const cellWidth = (inner - gap * 2) / 3;
  const cellHeight = 104;
  cells.forEach(([label, value], index) => {
    const cx = PAD + (index % 3) * (cellWidth + gap);
    const cy = y + Math.floor(index / 3) * (cellHeight + gap);
    ctx.fillStyle = C.panel;
    ctx.fillRect(cx, cy, cellWidth, cellHeight);
    font(ctx, 19, 700, MONO);
    ctx.fillStyle = C.muted;
    ctx.fillText(label, cx + 20, cy + 18);
    font(ctx, 38, 700);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, value, cellWidth - 40), cx + 20, cy + 48);
  });
  y += cellHeight * 2 + gap + 28;

  // Conditions and source at the bottom; the curve fills the space between.
  const footerY = H - PAD - 26;
  font(ctx, 24, 400);
  const conditions = wrap(ctx, conditionsText(report), inner, 3);
  const conditionsTop = footerY - 36 - conditions.length * 34 - 34;
  drawEquity(ctx, equity, m.initialCapital, PAD, y, inner, conditionsTop - 28 - y, report.currency);

  font(ctx, 22, 700, MONO);
  ctx.fillStyle = C.muted;
  ctx.fillText('УСЛОВИЯ ТЕСТА', PAD, conditionsTop);
  font(ctx, 24, 400);
  ctx.fillStyle = '#b8c3c7';
  conditions.forEach((line, index) => ctx.fillText(line, PAD, conditionsTop + 34 + index * 34));

  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, footerY - 20, inner, 2);
  font(ctx, 22, 400, MONO);
  ctx.fillStyle = C.muted;
  ctx.fillText(fit(ctx, `Источник: ${shortLink(report.sourceUrl)}`, inner), PAD, footerY);
}

/** The picture as PNG in base64, as the server expects it. */
export function canvasPngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
