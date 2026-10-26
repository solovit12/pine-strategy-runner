import { z } from 'zod';
import { BacktestTimeframeSchema, DefaultOrderSizeTypeSchema } from '../../../../packages/shared/src/contracts';
import { PINE_LIVE_TIMEFRAMES } from '../../../../packages/shared/src/strategy-catalog-contracts';

/**
 * The Strategy page's unsaved work survives a page reload: the editor code, the backtest form
 * and the Paper settings stay in this browser (each site keeps its own). Backtest results are
 * not kept; they are large and quick to recalculate.
 */

const EDITOR_KEY = 'psr.editorDraft.v1';
const PAPER_KEY = 'psr.paperDraft.v1';

const EditorDraftSchema = z.object({
  source: z.string(),
  symbol: z.string(),
  timeframe: BacktestTimeframeSchema,
  startDate: z.string(),
  endDate: z.string(),
  initialCapital: z.number(),
  defaultOrderSizeValue: z.number(),
  defaultOrderSizeType: DefaultOrderSizeTypeSchema,
  pyramiding: z.number(),
  commissionValueInput: z.string(),
  longLeverage: z.string(),
  shortLeverage: z.string(),
  /** Drafts saved before the percent setting had slippage ticks instead: they take the default. */
  slippagePercent: z.number().optional(),
  processOrdersOnClose: z.boolean(),
  /** Bar detail model; drafts saved before it existed use minute replay. */
  barDetail: z.enum(['high', 'default']).optional(),
  strategyName: z.string(),
  /** The saved strategy the editor was opened from, if any. */
  strategyId: z.string().nullable(),
});
export type EditorDraft = z.infer<typeof EditorDraftSchema>;

const MarketList = z.array(z.string());
const PaperDraftSchema = z.object({
  /** The saved strategy whose Paper settings these replace, if any. */
  strategyId: z.string().nullable(),
  kind: z.enum(['pine', 'python']),
  pythonRef: z.string(),
  paramText: z.record(z.string(), z.string()),
  timeframe: z.enum(PINE_LIVE_TIMEFRAMES),
  tracks: z.object({ Hyperliquid: MarketList, Lighter: MarketList }),
  capital: z.string(),
  orderSize: z.string(),
  fees: z.object({
    hyperliquidMakerFeePercent: z.string(),
    hyperliquidTakerFeePercent: z.string(),
    lighterMakerFeePercent: z.string(),
    lighterTakerFeePercent: z.string(),
  }),
});
export type PaperDraft = z.infer<typeof PaperDraftSchema>;

/** Browser storage can be missing, full or blocked (private windows); a draft is a convenience. */
function read<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* the page works without a saved draft */ }
}

export const readEditorDraft = (): EditorDraft | null => read(EDITOR_KEY, EditorDraftSchema);
export const writeEditorDraft = (draft: EditorDraft): void => write(EDITOR_KEY, draft);
export const readPaperDraft = (): PaperDraft | null => read(PAPER_KEY, PaperDraftSchema);
export const writePaperDraft = (draft: PaperDraft): void => write(PAPER_KEY, draft);
