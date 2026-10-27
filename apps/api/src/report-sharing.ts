import { createSign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  BACKTEST_RUNS_SHEET, BacktestReportSchema, SaveGoogleReportSettingsSchema, SaveTelegramReportSettingsSchema,
  TelegramBacktestPostSchema, type BacktestReport, type ReportSettingsView, type SheetRowResult, type TelegramPostResult,
} from '../../../packages/shared/src/report-contracts.js';
import { isCrossOriginPaperWrite } from './paper-routes.js';

/**
 * Backtest reports of the private edition: a row in the owner's Google Sheet (through a Google
 * robot account, "service account") and a picture post in the owner's Telegram channel (through
 * the owner's bot). The robot's key and the bot token stay in this server's data folder, readable
 * by the app only, and are never sent back to the page.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TELEGRAM_API = 'https://api.telegram.org';
const RUN_ID_HEADER = 'Run ID';
const TELEGRAM_HEADER = 'Пост в Telegram';

export class ReportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface GoogleRobotKey {
  readonly clientEmail: string;
  readonly privateKey: string;
}

/** The JSON key file Google gives for a robot account. Its token address is always Google's own. */
export function parseGoogleRobotKey(text: string): GoogleRobotKey {
  let value: { type?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    throw new ReportError(400, 'The key file is not JSON. Upload the .json file Google downloaded when you created the key.');
  }
  if (value.type !== 'service_account' || typeof value.client_email !== 'string' || !value.client_email.includes('@')
    || typeof value.private_key !== 'string' || !value.private_key.includes('PRIVATE KEY')) {
    throw new ReportError(400, 'This is not a robot account key. In Google Cloud: IAM → Service accounts → your robot → Keys → Add key → JSON.');
  }
  return { clientEmail: value.client_email, privateKey: value.private_key };
}

/** The sheet's id from its browser link (…/spreadsheets/d/<id>/edit) or the id itself. */
export function spreadsheetIdFrom(text: string): string {
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(text) ? text : null);
  if (!id) throw new ReportError(400, 'Paste the sheet\'s link from the browser address bar (https://docs.google.com/spreadsheets/d/…).');
  return id;
}

/** `@name`, a t.me/name link or a numeric id, as the Bot API expects it. */
export function telegramChatId(text: string): string {
  const value = text.trim();
  if (/^-?\d{5,}$/.test(value)) return value;
  const name = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/.exec(value)?.[1]
    ?? /^@?([A-Za-z][A-Za-z0-9_]{3,})$/.exec(value)?.[1];
  if (!name) throw new ReportError(400, 'Enter the channel as @name (its public link t.me/name) or its numeric id (-100…).');
  return `@${name}`;
}

function columnLetter(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function orderSizeText(report: BacktestReport): string {
  const { orderSizeValue: value, orderSizeType: type } = report.settings;
  return type === 'percent_of_equity' ? `${value} % капитала` : type === 'cash' ? `${value} ${report.currency}` : `${value} (кол-во)`;
}

function commissionText(report: BacktestReport): string {
  const { commissionType: type, commissionValue: value } = report.settings;
  return type === 'percent' ? `${value} %` : type === 'cash_per_contract' ? `${value} ${report.currency} за контракт`
    : `${value} ${report.currency} за заявку`;
}

function leverageText(marginPercent: number): string {
  return marginPercent > 0 ? `x${round(100 / marginPercent)}` : 'без ограничения';
}

function days(report: BacktestReport): number {
  return Math.round((Date.parse(`${report.dateRange.end}T00:00:00Z`) - Date.parse(`${report.dateRange.start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** How a column looks in the sheet. */
interface ColumnStyle {
  readonly group: 'run' | 'result' | 'conditions' | 'links';
  readonly width: number;
  /** Google Sheets number pattern. */
  readonly pattern?: string;
  readonly align?: 'LEFT' | 'CENTER' | 'RIGHT';
  readonly wrap?: 'WRAP' | 'CLIP';
  /** Green above zero, red below (`one`: above and below 1). */
  readonly colors?: 'fill' | 'text' | 'one';
  readonly hidden?: boolean;
  /** Shown when the mouse is over the header. */
  readonly note?: string;
}

export interface BacktestRunColumn extends ColumnStyle {
  readonly header: string;
  readonly value: (report: BacktestReport) => string | number;
}

const PERCENT = '0.00" %"';
const SIGNED_PERCENT = '+0.00" %";-0.00" %";0.00" %"';
const MONEY = '#,##0.00';
const SIGNED_MONEY = '+#,##0.00;-#,##0.00;0.00';
const WHOLE = '#,##0';

/**
 * The sheet's columns, in the order the sheet shows them: what was tested, the result, the test's
 * conditions, then links and service columns. Columns are found by their header, so a column the
 * owner adds stays where it is (after these).
 */
export const BACKTEST_RUN_COLUMNS: readonly BacktestRunColumn[] = [
  { header: 'Дата бэктеста (UTC)', group: 'run', width: 135, value: (r) => r.backtestedAt.slice(0, 16).replace('T', ' '),
    note: 'Когда сделан бэктест, время UTC.' },
  { header: 'Стратегия', group: 'run', width: 240, wrap: 'WRAP', value: (r) => r.strategyName,
    note: 'Название стратегии в библиотеке Svit Runner (или из strategy(...) в коде).' },
  { header: 'Источник', group: 'run', width: 170, wrap: 'CLIP', value: (r) => r.sourceUrl,
    note: 'Откуда стратегия: её страница на TradingView или в другом месте.' },
  { header: 'Рынок', group: 'run', width: 110, value: (r) => r.symbol },
  { header: 'Таймфрейм', group: 'run', width: 90, align: 'CENTER', value: (r) => r.timeframe },
  { header: 'С (UTC)', group: 'run', width: 95, align: 'CENTER', value: (r) => r.dateRange.start },
  { header: 'По (UTC)', group: 'run', width: 95, align: 'CENTER', value: (r) => r.dateRange.end },
  { header: 'Дней', group: 'run', width: 60, pattern: WHOLE, align: 'CENTER', value: days, note: 'Длина периода теста в календарных днях.' },
  { header: 'Итог, %', group: 'result', width: 100, pattern: SIGNED_PERCENT, colors: 'fill', value: (r) => round(r.metrics.totalProfitPercent),
    note: 'Изменение капитала за период, вместе с открытой на конец теста позицией.' },
  { header: 'Итог', group: 'result', width: 115, pattern: SIGNED_MONEY, colors: 'fill', value: (r) => round(r.metrics.totalProfit),
    note: 'То же в валюте счёта.' },
  { header: 'Сделок', group: 'result', width: 75, pattern: WHOLE, align: 'CENTER', value: (r) => r.metrics.totalTrades },
  { header: 'Прибыльных, %', group: 'result', width: 110, pattern: PERCENT, value: (r) => round(r.metrics.winRatePercent),
    note: 'Доля сделок, закрытых с прибылью.' },
  { header: 'Макс. просадка, %', group: 'result', width: 115, pattern: PERCENT, value: (r) => round(r.metrics.maxDrawdownPercent),
    note: 'Наибольшее падение капитала от его пика, в процентах.' },
  { header: 'Profit factor', group: 'result', width: 90, pattern: '0.00', colors: 'one',
    value: (r) => r.metrics.profitFactor === null ? '' : round(r.metrics.profitFactor, 3),
    note: 'Прибыль прибыльных сделок, делённая на убыток убыточных. Больше 1 — стратегия в плюсе.' },
  { header: 'Средняя сделка', group: 'result', width: 115, pattern: SIGNED_MONEY, colors: 'text', value: (r) => round(r.metrics.averageTrade),
    note: 'Средний результат одной закрытой сделки, в валюте счёта.' },
  { header: 'Макс. просадка', group: 'result', width: 115, pattern: MONEY, value: (r) => round(r.metrics.maxDrawdown),
    note: 'Наибольшее падение капитала от его пика, в валюте счёта.' },
  { header: 'Закрытые сделки', group: 'result', width: 115, pattern: SIGNED_MONEY, value: (r) => round(r.metrics.netProfit),
    note: 'Итог только закрытых сделок.' },
  { header: 'Открытая позиция', group: 'result', width: 115, pattern: SIGNED_MONEY, value: (r) => round(r.metrics.openProfit),
    note: 'Результат позиции, ещё открытой в конце теста.' },
  { header: 'Лонгов', group: 'result', width: 70, pattern: WHOLE, align: 'CENTER', value: (r) => r.metrics.longTrades },
  { header: 'Шортов', group: 'result', width: 70, pattern: WHOLE, align: 'CENTER', value: (r) => r.metrics.shortTrades },
  { header: 'Комиссии', group: 'result', width: 100, pattern: MONEY, value: (r) => round(r.metrics.commissionPaid),
    note: 'Сколько всего заплачено комиссий за тест.' },
  { header: 'Капитал', group: 'conditions', width: 100, pattern: MONEY, value: (r) => round(r.metrics.initialCapital),
    note: 'Стартовый капитал теста.' },
  { header: 'Валюта', group: 'conditions', width: 70, align: 'CENTER', value: (r) => r.currency },
  { header: 'Размер сделки', group: 'conditions', width: 130, value: orderSizeText },
  { header: 'Комиссия за исполнение', group: 'conditions', width: 130, value: commissionText,
    note: 'Комиссия биржи, которая берётся отдельно на каждый вход и выход.' },
  { header: 'Ухудшение цены, %', group: 'conditions', width: 115, pattern: PERCENT, value: (r) => r.settings.slippagePercent,
    note: 'Насколько хуже своей цены исполнялся каждый вход по рынку и каждый стоп: спред, задержка, проскальзывание.' },
  { header: 'Плечо лонг / шорт', group: 'conditions', width: 150, value: (r) => `${leverageText(r.settings.marginLongPercent)} / ${leverageText(r.settings.marginShortPercent)}` },
  { header: 'Пирамидинг', group: 'conditions', width: 95, pattern: WHOLE, align: 'CENTER', value: (r) => r.settings.pyramiding,
    note: 'Сколько входов в одну сторону может быть открыто одновременно.' },
  { header: 'Детализация', group: 'conditions', width: 130, value: (r) => r.settings.barDetailization === 'high' ? 'каждая минута' : '4 точки на свечу',
    note: 'Как проверялись стопы и тейки внутри свечи: по каждой минутной свече или по 4 точкам (как в бесплатном TradingView).' },
  { header: 'Исполнение по закрытию свечи', group: 'conditions', width: 120, align: 'CENTER', value: (r) => r.settings.processOrdersOnClose ? 'да' : 'нет',
    note: 'Рыночные заявки исполнялись по закрытию свечи сигнала, а не на открытии следующей (Fill orders on bar close в TradingView).' },
  { header: TELEGRAM_HEADER, group: 'links', width: 180, wrap: 'CLIP', value: () => '',
    note: 'Ссылка на пост с этим отчётом в Telegram, если он опубликован.' },
  { header: 'Версия', group: 'links', width: 95, align: 'CENTER',
    value: (r) => r.strategyVersion === null ? 'не сохранена' : r.strategyEdited ? `${r.strategyVersion} (изменена)` : r.strategyVersion,
    note: 'Версия стратегии в библиотеке; «изменена» — код в редакторе отличался от сохранённого.' },
  { header: 'Данные', group: 'links', width: 125, value: (r) => r.dataSource, note: 'Чьи свечи использованы в тесте.' },
  { header: 'Свечей', group: 'links', width: 80, pattern: WHOLE, align: 'CENTER', value: (r) => r.bars,
    note: 'Сколько свечей выбранного таймфрейма вошло в тест.' },
  { header: 'Предупреждения', group: 'links', width: 280, wrap: 'CLIP', value: (r) => r.warnings.join(' | ').slice(0, 5_000),
    note: 'Замечания сервиса к этому тесту.' },
  { header: RUN_ID_HEADER, group: 'links', width: 100, wrap: 'CLIP', hidden: true, value: (r) => r.runId,
    note: 'Служебный номер бэктеста: по нему сервис не добавляет один тест дважды.' },
];

/** Bump when the sheet's look changes: the next press restyles the sheet once. */
export const SHEET_FORMAT_VERSION = '1';
const FORMAT_METADATA_KEY = 'svitRunnerSheetFormat';

const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const GROUP_COLORS: Record<ColumnStyle['group'], string> = { run: '#37474f', result: '#1e6b4f', conditions: '#3d4f7a', links: '#5f6368' };
const GOOD = { background: '#e6f4ea', text: '#137333' };
const BAD = { background: '#fce8e6', text: '#c5221f' };

/**
 * The batchUpdate requests that style Backtest Runs: our columns first in our order, a colored
 * header per group with notes, widths, number formats, green/red results, banded rows, a filter,
 * frozen date and strategy. `existing` are the sheet's rules and bands from before, replaced.
 */
export function sheetFormatRequests(sheetId: number, headers: readonly string[], existing: { conditionalRules: number; bandIds: readonly number[] }):
  { requests: object[]; headers: string[] } {
  const requests: object[] = [];
  const order = [...headers];
  BACKTEST_RUN_COLUMNS.forEach((column, target) => {
    const from = order.indexOf(column.header);
    if (from < 0 || from === target) return;
    requests.push({ moveDimension: { source: { sheetId, dimension: 'COLUMNS', startIndex: from, endIndex: from + 1 }, destinationIndex: target } });
    order.splice(target, 0, ...order.splice(from, 1));
  });
  for (let index = existing.conditionalRules - 1; index >= 0; index -= 1) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  for (const bandedRangeId of existing.bandIds) requests.push({ deleteBanding: { bandedRangeId } });

  const columns = order.length;
  requests.push(
    { updateSheetProperties: { properties: { sheetId, tabColorStyle: { rgbColor: rgb(GROUP_COLORS.result) },
      gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } }, fields: 'tabColorStyle,gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 52 }, fields: 'pixelSize' } },
    // Data rows: plain text in the middle of the row (a new row copies this, not the bold header).
    { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
      cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE', textFormat: { bold: false, fontSize: 10 } } },
      fields: 'userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize' } },
    { addBanding: { bandedRange: { range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
      rowProperties: { firstBandColorStyle: { rgbColor: rgb('#ffffff') }, secondBandColorStyle: { rgbColor: rgb('#f3f6f7') } } } } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columns } } } },
  );
  order.forEach((header, index) => {
    const column = BACKTEST_RUN_COLUMNS.find((item) => item.header === header);
    if (!column) return;
    const cells = { sheetId, startColumnIndex: index, endColumnIndex: index + 1 };
    requests.push(
      { updateCells: { range: { ...cells, startRowIndex: 0, endRowIndex: 1 }, fields: 'note,userEnteredFormat', rows: [{ values: [{
        note: column.note ?? '',
        userEnteredFormat: { backgroundColorStyle: { rgbColor: rgb(GROUP_COLORS[column.group]) }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP', textFormat: { bold: true, fontSize: 10, foregroundColorStyle: { rgbColor: rgb('#ffffff') } } },
      }] }] } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: column.width, hiddenByUser: column.hidden === true }, fields: 'pixelSize,hiddenByUser' } },
    );
    const format: Record<string, unknown> = {};
    if (column.pattern) format.numberFormat = { type: 'NUMBER', pattern: column.pattern };
    if (column.align) format.horizontalAlignment = column.align;
    if (column.wrap) format.wrapStrategy = column.wrap;
    if (Object.keys(format).length) {
      requests.push({ repeatCell: { range: { ...cells, startRowIndex: 1 }, cell: { userEnteredFormat: format },
        fields: Object.keys(format).map((key) => `userEnteredFormat.${key}`).join(',') } });
    }
    if (column.colors) {
      const threshold = column.colors === 'one' ? '1' : '0';
      const style = (tone: typeof GOOD) => column.colors === 'fill'
        ? { backgroundColor: rgb(tone.background), textFormat: { bold: true, foregroundColor: rgb(tone.text) } }
        : { textFormat: { foregroundColor: rgb(tone.text) } };
      for (const [type, tone] of [['NUMBER_GREATER', GOOD], ['NUMBER_LESS', BAD]] as const) {
        requests.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [{ ...cells, startRowIndex: 1 }],
          booleanRule: { condition: { type, values: [{ userEnteredValue: threshold }] }, format: style(tone) } } } });
      }
    }
  });
  return { requests, headers: order };
}

/** One request with a clear error instead of the network library's own. */
async function request(http: typeof fetch, service: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await http(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    throw new ReportError(502, `Could not reach ${service}${typeof cause === 'string' ? ` (${cause})` : ''}. Try again in a minute.`);
  }
}

interface SheetInfo {
  readonly title: string;
  readonly sheetId: number;
  readonly conditionalRules: number;
  readonly bandIds: readonly number[];
  /** Which look the service gave this sheet last. */
  readonly format: { readonly id: number; readonly version: string } | null;
}

/** Google Sheets through a robot account: a signed request for a one-hour token, then the Sheets API. */
export class GoogleSheets {
  #token: { value: string; expiresAt: number } | null = null;

  constructor(readonly key: GoogleRobotKey, private readonly http: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - 60_000 > this.now()) return this.#token.value;
    const issuedAt = Math.floor(this.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.key.clientEmail, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(this.key.privateKey, 'base64url');
    } catch {
      throw new ReportError(400, 'The robot key file is damaged: its private key cannot sign. Create a new JSON key.');
    }
    const response = await request(this.http, 'Google', GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = await response.json().catch(() => null) as { access_token?: string; expires_in?: number; error_description?: string } | null;
    if (!response.ok || !body?.access_token) {
      throw new ReportError(502, `Google did not accept the robot's key${body?.error_description ? `: ${body.error_description}` : ` (HTTP ${response.status})`}. `
        + 'The key may be deleted in Google Cloud; create a new JSON key.');
    }
    this.#token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async #call<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const response = await request(this.http, 'Google', `${SHEETS_API}/${pathAndQuery}`, {
      method, headers: { authorization: `Bearer ${await this.#accessToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null) as { error?: { message?: string; details?: { reason?: string }[] } } | null;
    if (response.status === 403) {
      // The same answer means two things: the Sheets API is off in the robot's project, or the sheet is not shared with the robot.
      if (json?.error?.details?.some((detail) => detail.reason === 'SERVICE_DISABLED') || /has not been used|is disabled/i.test(json?.error?.message ?? '')) {
        const project = /@([^.@]+)\.iam\.gserviceaccount\.com$/.exec(this.key.clientEmail)?.[1];
        throw new ReportError(403, 'The Google Sheets API is switched off in the robot\'s Google Cloud project. Open '
          + `https://console.cloud.google.com/apis/library/sheets.googleapis.com${project ? `?project=${project}` : ''}, press Enable, wait a minute and try again.`);
      }
      throw new ReportError(403, `The robot has no access to this sheet. In the sheet press Share, add ${this.key.clientEmail} and choose Editor.`);
    }
    if (response.status === 404) throw new ReportError(404, 'Google cannot find this sheet. Check the link.');
    if (!response.ok) throw new ReportError(502, `Google Sheets answered HTTP ${response.status}${json?.error?.message ? `: ${json.error.message}` : ''}.`);
    return json as T;
  }

  #range(sheet: string, cells: string): string {
    return encodeURIComponent(`'${sheet.replaceAll('\'', '\'\'')}'!${cells}`);
  }

  async spreadsheet(id: string): Promise<{ title: string; sheets: SheetInfo[] }> {
    const info = await this.#call<{ properties: { title: string }; sheets?: {
      properties: { title: string; sheetId: number }; conditionalFormats?: unknown[]; bandedRanges?: { bandedRangeId: number }[];
      developerMetadata?: { metadataId: number; metadataKey: string; metadataValue?: string }[];
    }[] }>('GET', `${id}?fields=properties.title,sheets(properties(sheetId,title),conditionalFormats(ranges(sheetId)),`
      + 'bandedRanges(bandedRangeId),developerMetadata(metadataId,metadataKey,metadataValue))');
    return { title: info.properties.title, sheets: (info.sheets ?? []).map((sheet) => {
      const format = sheet.developerMetadata?.find((item) => item.metadataKey === FORMAT_METADATA_KEY);
      return { ...sheet.properties, conditionalRules: sheet.conditionalFormats?.length ?? 0,
        bandIds: (sheet.bandedRanges ?? []).map((band) => band.bandedRangeId),
        format: format ? { id: format.metadataId, version: format.metadataValue ?? '' } : null };
    }) };
  }

  /**
   * The sheet (created when missing) and its header row, with any missing columns added at the end;
   * a sheet not yet in this version's look is restyled once (see sheetFormatRequests).
   */
  async ensureSheet(id: string, title: string, columns: readonly string[]): Promise<{ sheetId: number; headers: string[]; styleError: string | null }> {
    let sheet: Pick<SheetInfo, 'sheetId' | 'conditionalRules' | 'bandIds' | 'format'> | undefined
      = (await this.spreadsheet(id)).sheets.find((item) => item.title === title);
    if (!sheet) {
      const created = await this.#call<{ replies: { addSheet: { properties: { sheetId: number } } }[] }>('POST', `${id}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title } } }],
      });
      sheet = { sheetId: created.replies[0]!.addSheet.properties.sheetId, conditionalRules: 0, bandIds: [], format: null };
    }
    const read = await this.#call<{ values?: string[][] }>('GET', `${id}/values/${this.#range(title, '1:1')}`);
    let headers = [...(read.values?.[0] ?? [])];
    const missing = columns.filter((column) => !headers.includes(column));
    if (missing.length) {
      await this.#call('PUT', `${id}/values/${this.#range(title, `${columnLetter(headers.length)}1`)}?valueInputOption=RAW`, { values: [missing] });
      headers.push(...missing);
    }
    if (sheet.format?.version !== SHEET_FORMAT_VERSION) {
      const styled = sheetFormatRequests(sheet.sheetId, headers, sheet);
      const mark = sheet.format
        ? { updateDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataId: sheet.format.id } }],
          developerMetadata: { metadataValue: SHEET_FORMAT_VERSION }, fields: 'metadataValue' } }
        : { createDeveloperMetadata: { developerMetadata: { metadataKey: FORMAT_METADATA_KEY, metadataValue: SHEET_FORMAT_VERSION,
          location: { sheetId: sheet.sheetId }, visibility: 'DOCUMENT' } } };
      // The look is only looks: when Google refuses it (all or nothing), rows are still written and the next press tries again.
      try {
        await this.#call('POST', `${id}:batchUpdate`, { requests: [...styled.requests, mark] });
        headers = styled.headers;
      } catch (error) {
        return { sheetId: sheet.sheetId, headers, styleError: error instanceof Error ? error.message : String(error) };
      }
    }
    return { sheetId: sheet.sheetId, headers, styleError: null };
  }

  /** Every row of the sheet as stored (numbers as numbers), the header row first. */
  async rows(id: string, title: string): Promise<(string | number | boolean)[][]> {
    const read = await this.#call<{ values?: (string | number | boolean)[][] }>('GET',
      `${id}/values/${encodeURIComponent(`'${title.replaceAll('\'', '\'\'')}'`)}?valueRenderOption=UNFORMATTED_VALUE`);
    return read.values ?? [];
  }

  /** Writes a row under the table (into the styled empty row, new rows only past the sheet's end) and returns its 1-based number. */
  async appendRow(id: string, title: string, values: readonly (string | number)[]): Promise<number> {
    const result = await this.#call<{ updates?: { updatedRange?: string } }>('POST',
      `${id}/values/${this.#range(title, 'A1')}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`, { values: [values] });
    const row = Number(/![A-Z]+(\d+)/.exec(result.updates?.updatedRange ?? '')?.[1]);
    if (!Number.isInteger(row)) throw new ReportError(502, 'Google added the row but did not say where.');
    return row;
  }

  async setCell(id: string, title: string, column: number, row: number, value: string): Promise<void> {
    await this.#call('PUT', `${id}/values/${this.#range(title, `${columnLetter(column)}${row}`)}?valueInputOption=RAW`, { values: [[value]] });
  }
}

interface TelegramChat { id: number; title?: string; username?: string; type: string }

/** The owner's bot through the Telegram Bot API. Errors never contain the token. */
export class TelegramBot {
  constructor(private readonly token: string, private readonly http: typeof fetch = fetch) {}

  async #call<T>(method: string, body: FormData | Record<string, unknown>): Promise<T> {
    const form = body instanceof FormData;
    const response = await request(this.http, 'Telegram', `${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST', headers: form ? {} : { 'content-type': 'application/json' }, body: form ? body : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!json?.ok) {
      if (response.status === 401 || response.status === 404) throw new ReportError(400, 'Telegram did not accept the bot token. Copy it again from @BotFather.');
      throw new ReportError(response.status === 400 || response.status === 403 ? 400 : 502,
        `Telegram: ${(json?.description ?? `HTTP ${response.status}`).replaceAll(this.token, '…')}`);
    }
    return json.result as T;
  }

  getMe(): Promise<{ id: number; username: string }> {
    return this.#call('getMe', {});
  }

  getChat(chatId: string): Promise<TelegramChat> {
    return this.#call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId: string, userId: number): Promise<{ status: string; can_post_messages?: boolean }> {
    return this.#call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  sendPhoto(chatId: string, png: Buffer, caption: string): Promise<{ message_id: number; chat: TelegramChat }> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', caption);
    form.set('photo', new Blob([png], { type: 'image/png' }), 'backtest.png');
    return this.#call('sendPhoto', form);
  }
}

/** A post's public address: t.me/<channel>/<n>, or t.me/c/<id>/<n> for a channel without a public name. */
export function telegramMessageUrl(chat: TelegramChat, messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

interface StoredGoogle { readonly spreadsheetId: string; readonly spreadsheetTitle: string }
interface StoredTelegram { readonly botToken: string; readonly chatId: string; readonly channel: string; readonly channelTitle: string; readonly botUsername: string }

/** The connections, in the app's data folder: closed to everyone but the app (0700 folder, 0600 files). */
export class ReportSettingsStore {
  constructor(readonly directory: string) {}

  #read<T>(name: string): T | null {
    const file = path.join(this.directory, name);
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null;
    } catch {
      return null;
    }
  }

  #write(name: string, value: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, name);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }

  google(): { key: GoogleRobotKey; sheet: StoredGoogle } | null {
    const key = this.#read<GoogleRobotKey>('google-robot-key.json');
    const sheet = this.#read<StoredGoogle>('google-sheet.json');
    return key?.clientEmail && key.privateKey && sheet?.spreadsheetId ? { key, sheet } : null;
  }

  saveGoogle(key: GoogleRobotKey, sheet: StoredGoogle): void {
    this.#write('google-robot-key.json', key);
    this.#write('google-sheet.json', sheet);
  }

  telegram(): StoredTelegram | null {
    const value = this.#read<StoredTelegram>('telegram.json');
    return value?.botToken && value.chatId ? value : null;
  }

  saveTelegram(value: StoredTelegram): void {
    this.#write('telegram.json', value);
  }

  view(): ReportSettingsView {
    const google = this.google();
    const telegram = this.telegram();
    return {
      google: {
        connected: google !== null, robotEmail: google?.key.clientEmail ?? null, spreadsheetTitle: google?.sheet.spreadsheetTitle ?? null,
        sheetUrl: google ? `https://docs.google.com/spreadsheets/d/${google.sheet.spreadsheetId}/edit` : null,
      },
      telegram: {
        connected: telegram !== null, channelTitle: telegram?.channelTitle ?? null, channel: telegram?.channel ?? null,
        botUsername: telegram?.botUsername ?? null,
      },
    };
  }
}

/** The run's row in Backtest Runs: added once (found again by its Run ID); a post link fills its Telegram cell. */
/**
 * Columns that do not make a test different: when it ran, where it was posted, the run's number,
 * and the library's link and version (saving a source link makes a new version of the same code).
 */
const NOT_THE_TEST = new Set(['Дата бэктеста (UTC)', TELEGRAM_HEADER, RUN_ID_HEADER, 'Источник', 'Версия']);
const cell = (value: unknown) => value === undefined || value === null ? '' : String(value);

/**
 * The run's row in Backtest Runs: added once. The same run (its Run ID), or a new run of the same
 * test (same strategy, market, period, data, settings and numbers), finds its existing row instead;
 * a post link fills that row's Telegram cell.
 */
export async function addBacktestRow(sheets: GoogleSheets, spreadsheetId: string, report: BacktestReport,
  telegramUrl: string | null = null): Promise<SheetRowResult> {
  const { sheetId, headers, styleError } = await sheets.ensureSheet(spreadsheetId, BACKTEST_RUNS_SHEET, BACKTEST_RUN_COLUMNS.map((column) => column.header));
  const style = styleError ? { styleError } : {};
  const url = (row: number) => `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=A${row}`;
  const telegramColumn = headers.indexOf(TELEGRAM_HEADER);
  const values = headers.map((header) => BACKTEST_RUN_COLUMNS.find((column) => column.header === header)?.value(report) ?? '');
  const rows = await sheets.rows(spreadsheetId, BACKTEST_RUNS_SHEET);
  const runColumn = headers.indexOf(RUN_ID_HEADER);
  const compared = headers.map((header, index) => BACKTEST_RUN_COLUMNS.some((column) => column.header === header) && !NOT_THE_TEST.has(header) ? index : -1)
    .filter((index) => index >= 0);
  const sameRun = rows.findIndex((row, index) => index > 0 && cell(row[runColumn]) === report.runId);
  const sameTest = sameRun > 0 ? -1 : rows.findIndex((row, index) => index > 0 && compared.every((column) => cell(row[column]) === cell(values[column])));
  const existing = sameRun > 0 ? sameRun : sameTest;
  if (existing > 0) {
    if (telegramUrl) await sheets.setCell(spreadsheetId, BACKTEST_RUNS_SHEET, telegramColumn, existing + 1, telegramUrl);
    return { status: sameRun > 0 ? 'already' : 'same-test', row: existing + 1, url: url(existing + 1), ...style };
  }
  if (telegramUrl) values[telegramColumn] = telegramUrl;
  const row = await sheets.appendRow(spreadsheetId, BACKTEST_RUNS_SHEET, values);
  return { status: 'added', row, url: url(row), ...style };
}

export interface ReportRouteDependencies {
  readonly store: ReportSettingsStore;
  /** Tests replace Google and Telegram. */
  readonly http?: typeof fetch;
  readonly now?: () => number;
}

export function registerReportRoutes(app: FastifyInstance, dependencies: ReportRouteDependencies): void {
  const { store } = dependencies;
  const http = dependencies.http ?? fetch;
  const now = dependencies.now ?? Date.now;
  // One Google client per key keeps its one-hour token between presses.
  let cached: GoogleSheets | null = null;
  const sheetsFor = (key: GoogleRobotKey) => {
    if (cached?.key.clientEmail !== key.clientEmail || cached.key.privateKey !== key.privateKey) cached = new GoogleSheets(key, http, now);
    return cached;
  };
  // Presses run one after another, so two quick presses cannot both add the same run.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const handle = (work: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method !== 'GET' && isCrossOriginPaperWrite(request)) {
      return reply.code(403).send({ kind: 'REPORT_ORIGIN_FORBIDDEN', error: 'Reports require a same-origin request.' });
    }
    try {
      return await work(request);
    } catch (error) {
      if (error instanceof ReportError) return reply.code(error.status).send({ kind: 'REPORT_FAILED', error: error.message });
      throw error;
    }
  };
  const invalid = (what: string, issues: readonly { path: PropertyKey[]; message: string }[]) =>
    new ReportError(400, `${what}: ${issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'value'} — ${issue.message}`).join('; ')}.`);

  app.get('/api/reports/settings', handle(async () => store.view()));

  app.put('/api/reports/google', handle(async (request) => {
    // The key is never echoed back, not even in validation details.
    const parsed = SaveGoogleReportSettingsSchema.safeParse(request.body);
    if (!parsed.success) throw new ReportError(400, 'Paste the sheet\'s link and upload the robot\'s JSON key file.');
    const key = parsed.data.serviceAccountKey ? parseGoogleRobotKey(parsed.data.serviceAccountKey) : store.google()?.key;
    if (!key) throw new ReportError(400, 'Upload the robot\'s JSON key file.');
    const spreadsheetId = spreadsheetIdFrom(parsed.data.sheet);
    const sheets = sheetsFor(key);
    const info = await sheets.spreadsheet(spreadsheetId);
    await sheets.ensureSheet(spreadsheetId, BACKTEST_RUNS_SHEET, BACKTEST_RUN_COLUMNS.map((column) => column.header));
    store.saveGoogle(key, { spreadsheetId, spreadsheetTitle: info.title });
    return store.view();
  }));

  app.put('/api/reports/telegram', handle(async (request) => {
    const parsed = SaveTelegramReportSettingsSchema.safeParse(request.body);
    if (!parsed.success) throw new ReportError(400, 'Enter the channel and the bot token from @BotFather.');
    const token = parsed.data.botToken || store.telegram()?.botToken;
    if (!token) throw new ReportError(400, 'Enter the bot token from @BotFather.');
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new ReportError(400, 'This does not look like a bot token. It looks like 123456789:AA… and comes from @BotFather.');
    const bot = new TelegramBot(token, http);
    const me = await bot.getMe();
    const chat = await bot.getChat(telegramChatId(parsed.data.channel));
    const member = await bot.getChatMember(String(chat.id), me.id);
    if (member.status !== 'administrator' || (chat.type === 'channel' && member.can_post_messages === false)) {
      throw new ReportError(400, `Make @${me.username} an administrator of the channel with the right to post messages, then check again.`);
    }
    store.saveTelegram({ botToken: token, chatId: String(chat.id), channel: chat.username ? `@${chat.username}` : String(chat.id),
      channelTitle: chat.title ?? chat.username ?? String(chat.id), botUsername: me.username });
    return store.view();
  }));

  app.post('/api/reports/backtests/sheet', handle(async (request): Promise<SheetRowResult> => {
    const parsed = BacktestReportSchema.safeParse(request.body);
    if (!parsed.success) throw invalid('The report is incomplete', parsed.error.issues);
    const google = store.google();
    if (!google) throw new ReportError(409, 'Connect the Google Sheet first.');
    return serial(() => addBacktestRow(sheetsFor(google.key), google.sheet.spreadsheetId, parsed.data));
  }));

  app.post('/api/reports/backtests/telegram', { bodyLimit: 16 * 1024 * 1024 }, handle(async (request): Promise<TelegramPostResult> => {
    const parsed = TelegramBacktestPostSchema.safeParse(request.body);
    if (!parsed.success) throw invalid('The post is incomplete', parsed.error.issues);
    const telegram = store.telegram();
    if (!telegram) throw new ReportError(409, 'Connect the Telegram channel first.');
    const png = Buffer.from(parsed.data.imagePngBase64, 'base64');
    if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new ReportError(400, 'The picture is not a PNG.');
    const message = await new TelegramBot(telegram.botToken, http).sendPhoto(telegram.chatId, png, parsed.data.caption);
    const messageUrl = telegramMessageUrl(message.chat, message.message_id);
    // Every published post is in the journal too: the run's row gets the post link (added if missing).
    const google = store.google();
    if (!google) return { messageUrl, sheet: null, sheetError: null };
    try {
      const sheet = await serial(() => addBacktestRow(sheetsFor(google.key), google.sheet.spreadsheetId, parsed.data.report, messageUrl));
      return { messageUrl, sheet, sheetError: null };
    } catch (error) {
      return { messageUrl, sheet: null, sheetError: error instanceof Error ? error.message : String(error) };
    }
  }));
}
