import { z } from 'zod';

import { BacktestTimeframeSchema, BarDetailizationSchema, CommissionTypeSchema, DefaultOrderSizeTypeSchema } from './contracts.js';

/**
 * Backtest reports (private edition): a row in the owner's Google Sheet and a picture post in
 * the owner's Telegram channel. The Google key and the bot token stay on the server.
 */
export const BACKTEST_RUNS_SHEET = 'Backtest Runs';

/** Telegram allows this many characters under a photo. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

const SourceUrlSchema = z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).max(500);

export const BacktestReportSchema = z.object({
  /** The run this report describes; the sheet keeps one row per run. */
  runId: z.string().min(1).max(200),
  backtestedAt: z.iso.datetime(),
  strategyName: z.string().trim().min(1).max(200),
  /** Library version, or null for code that is not saved in the library. */
  strategyVersion: z.number().int().positive().nullable(),
  /** The code differs from that library version. */
  strategyEdited: z.boolean(),
  sourceUrl: SourceUrlSchema,
  dataSource: z.string().min(1).max(80),
  symbol: z.string().min(1).max(64),
  timeframe: BacktestTimeframeSchema,
  dateRange: z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  bars: z.number().int().min(0),
  currency: z.enum(['USDT', 'USDC']),
  metrics: z.object({
    initialCapital: z.number().finite(),
    endingEquity: z.number().finite(),
    netProfit: z.number().finite(),
    openProfit: z.number().finite(),
    totalProfit: z.number().finite(),
    totalProfitPercent: z.number().finite(),
    totalTrades: z.number().int().min(0),
    winRatePercent: z.number().finite(),
    maxDrawdown: z.number().finite(),
    maxDrawdownPercent: z.number().finite(),
    profitFactor: z.number().finite().nullable(),
    averageTrade: z.number().finite(),
    longTrades: z.number().int().min(0),
    shortTrades: z.number().int().min(0),
    commissionPaid: z.number().finite(),
  }),
  settings: z.object({
    orderSizeValue: z.number().finite(),
    orderSizeType: DefaultOrderSizeTypeSchema,
    pyramiding: z.number().int().min(0),
    commissionType: CommissionTypeSchema,
    commissionValue: z.number().finite(),
    slippagePercent: z.number().finite(),
    marginLongPercent: z.number().finite(),
    marginShortPercent: z.number().finite(),
    barDetailization: BarDetailizationSchema,
    processOrdersOnClose: z.boolean(),
  }),
  warnings: z.array(z.string().max(1_000)).max(50),
});

export type BacktestReport = z.infer<typeof BacktestReportSchema>;

export const TelegramBacktestPostSchema = z.object({
  report: BacktestReportSchema,
  caption: z.string().trim().min(1).max(TELEGRAM_CAPTION_LIMIT),
  /** The picture, PNG in base64 (no data: prefix). */
  imagePngBase64: z.string().min(100).max(12_000_000).regex(/^[A-Za-z0-9+/]+=*$/),
});

export type TelegramBacktestPost = z.infer<typeof TelegramBacktestPostSchema>;

export const SaveGoogleReportSettingsSchema = z.object({
  /** The sheet's link from the browser, or its id. */
  sheet: z.string().trim().min(10).max(500),
  /** The robot's JSON key file; may be left out to keep the saved one. */
  serviceAccountKey: z.string().max(20_000).optional(),
});

export const SaveTelegramReportSettingsSchema = z.object({
  /** @channelname, a t.me link, or the channel's numeric id. */
  channel: z.string().trim().min(2).max(200),
  /** From @BotFather; may be left out to keep the saved one. */
  botToken: z.string().trim().max(200).optional(),
});

export interface ReportSettingsView {
  readonly google: {
    readonly connected: boolean;
    readonly robotEmail: string | null;
    readonly spreadsheetTitle: string | null;
    readonly sheetUrl: string | null;
  };
  readonly telegram: {
    readonly connected: boolean;
    readonly channelTitle: string | null;
    readonly channel: string | null;
    readonly botUsername: string | null;
  };
}

export interface SheetRowResult {
  /** `already`: this run is in the sheet; `same-test`: another run of the same test is. */
  readonly status: 'added' | 'already' | 'same-test';
  readonly row: number;
  readonly url: string;
  /** The row is written, but Google refused the sheet's look (tried again on the next press). */
  readonly styleError?: string;
}

export interface TelegramPostResult {
  readonly messageUrl: string | null;
  /** The run's row in the sheet with the post link, or why it could not be written. */
  readonly sheet: SheetRowResult | null;
  readonly sheetError: string | null;
}
