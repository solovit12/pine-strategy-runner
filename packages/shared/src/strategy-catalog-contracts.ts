import { z } from 'zod';

import { BacktestRequestSchema, type BacktestRequest } from './contracts.js';

export const PAPER_CATALOG_MARKETS = [
  'BTC', 'ETH', 'HYPE', 'SOL', 'XRP', 'ZEC', 'NEAR', 'UNI', 'PUMP', 'LIT',
  'SUI', 'DOGE', 'ENA', 'AAVE',
] as const;

const PaperTrackSchema = z.object({
  venue: z.enum(['Hyperliquid', 'Lighter']),
  market: z.enum(PAPER_CATALOG_MARKETS),
}).strict();

function validatePaperTracks(
  tracks: readonly z.infer<typeof PaperTrackSchema>[],
  context: z.RefinementCtx,
  maxPerVenue: boolean,
): void {
  const keys = new Set<string>();
  const venues = new Set<string>();
  const countByVenue = new Map<string, number>();
  for (const [index, track] of tracks.entries()) {
    const key = `${track.venue}:${track.market}`;
    if (keys.has(key)) {
      context.addIssue({ code: 'custom', path: ['tracks', index], message: 'Duplicate venue and market.' });
    }
    keys.add(key);
    venues.add(track.venue);
    countByVenue.set(track.venue, (countByVenue.get(track.venue) ?? 0) + 1);
  }
  for (const venue of ['Hyperliquid', 'Lighter']) {
    if (!venues.has(venue)) {
      context.addIssue({ code: 'custom', path: ['tracks'], message: `Choose at least one ${venue} market.` });
    }
    if (maxPerVenue && (countByVenue.get(venue) ?? 0) > 10) {
      context.addIssue({ code: 'custom', path: ['tracks'], message: `Choose no more than 10 ${venue} markets.` });
    }
  }
}

/** Old drafts remain readable, but they cannot be launched as shared accounts. */
export const LegacyPaperStrategySettingsSchema = z.object({
  timeframe: z.literal('1h'),
  tracks: z.array(PaperTrackSchema).max(20),
  capitalPerTrack: z.number().finite().positive().max(1_000_000_000_000),
  targetOrderValue: z.number().finite().positive().max(1_000_000_000_000),
  hyperliquidFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterFeePercent: z.number().finite().min(0).max(100).nullable(),
}).strict().superRefine((value, context) => validatePaperTracks(value.tracks, context, false));

/** Historical shared-account drafts remain readable, but cannot launch under fee-split V2. */
export const VenueSharedPaperStrategySettingsSchema = z.object({
  accountModel: z.literal('venue_shared_v1'),
  timeframe: z.literal('1h'),
  tracks: z.array(PaperTrackSchema).max(20),
  capitalPerVenue: z.number().finite().positive().max(1_000_000_000_000),
  orderSizePercentOfRealizedEquity: z.literal(10),
  hyperliquidFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterFeePercent: z.number().finite().min(0).max(100).nullable(),
}).strict().superRefine((value, context) => validatePaperTracks(value.tracks, context, true));

/** One virtual account per venue, with separate maker entry and taker exit fees. */
export const VenueSharedPaperStrategySettingsV2Schema = z.object({
  accountModel: z.literal('venue_shared_v2'),
  timeframe: z.literal('1h'),
  tracks: z.array(PaperTrackSchema).max(20),
  capitalPerVenue: z.number().finite().positive().max(1_000_000_000_000),
  orderSizePercentOfRealizedEquity: z.literal(10),
  hyperliquidMakerEntryFeePercent: z.number().finite().min(0).max(100).nullable(),
  hyperliquidTakerExitFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterMakerEntryFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterTakerExitFeePercent: z.number().finite().min(0).max(100).nullable(),
}).strict().superRefine((value, context) => validatePaperTracks(value.tracks, context, true));

/**
 * Any USDC perpetual listed by the venue (checked live at launch). Hyperliquid
 * HIP-3 markets carry their deployer's prefix, e.g. `xyz:NVDA`.
 */
export const PAPER_MARKET_SYMBOL_PATTERN = /^(?:[a-z][a-z0-9]{0,7}:)?[A-Za-z0-9]{1,20}$/;
/** HIP-3 deployers (perp DEXs) whose markets Paper lists next to Hyperliquid's own. */
export const HYPERLIQUID_HIP3_DEXES = ['xyz'] as const;

/** `xyz` for `xyz:NVDA`; null for a venue's own market. */
export function hip3Dex(market: string): string | null {
  const separator = market.indexOf(':');
  return separator > 0 ? market.slice(0, separator) : null;
}

/**
 * Fee multiplier of a HIP-3 market relative to the user's ordinary Hyperliquid
 * fee: deployerFeeScale s gives 1+s below 1 and 2s from 1; growth mode cuts it
 * by 90 %. https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 */
export function hip3FeeMultiplier(deployerFeeScale: number, growthMode: boolean): number {
  const scale = deployerFeeScale < 1 ? 1 + deployerFeeScale : 2 * deployerFeeScale;
  return scale * (growthMode ? 0.1 : 1);
}
export const PINE_LIVE_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

export const PineLiveTrackSchema = z.object({
  venue: z.enum(['Hyperliquid', 'Lighter']),
  market: z.string().regex(PAPER_MARKET_SYMBOL_PATTERN),
}).strict();

/**
 * Generic Pine Paper: the saved Pine strategy runs on the venue's own closed
 * candles and its orders execute in real time against live order books.
 * Entry size is a percent of the venue's virtual account; Pine decides
 * direction and timing.
 */
const liveSettingsShape = {
  timeframe: z.enum(PINE_LIVE_TIMEFRAMES),
  // A saved draft may have no markets yet (Save from the Backtest editor); launch requires them.
  tracks: z.array(PineLiveTrackSchema).max(20),
  capitalPerVenue: z.number().finite().min(100).max(1_000_000_000_000),
  orderSizePercent: z.number().finite().gt(0).max(100),
  hyperliquidMakerFeePercent: z.number().finite().min(0).max(100).nullable(),
  hyperliquidTakerFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterMakerFeePercent: z.number().finite().min(0).max(100).nullable(),
  lighterTakerFeePercent: z.number().finite().min(0).max(100).nullable(),
};

function validateLiveTracks(value: { tracks: readonly { venue: string; market: string }[] }, context: z.RefinementCtx): void {
  const keys = new Set<string>();
  for (const [index, track] of value.tracks.entries()) {
    const key = `${track.venue}:${track.market}`;
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['tracks', index], message: 'Duplicate venue and market.' });
    keys.add(key);
  }
  for (const venue of ['Hyperliquid', 'Lighter']) {
    if (value.tracks.filter((track) => track.venue === venue).length > 10) {
      context.addIssue({ code: 'custom', path: ['tracks'], message: `Choose no more than 10 ${venue} markets.` });
    }
  }
  for (const [index, track] of value.tracks.entries()) {
    if (track.venue === 'Lighter' && hip3Dex(track.market) !== null) {
      context.addIssue({ code: 'custom', path: ['tracks', index], message: 'Prefixed (HIP-3) markets exist only on Hyperliquid.' });
    }
  }
}

export const PineLivePaperSettingsV1Schema = z.object({
  accountModel: z.literal('pine_live_v1'),
  ...liveSettingsShape,
}).strict().superRefine(validateLiveTracks);

/** `<pack>/<module>:<Class>` of a Python strategy in a configured strategy pack. */
export const PYTHON_STRATEGY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}\/[A-Za-z_][A-Za-z0-9_]{0,63}:[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Catalog "source" of a Python strategy: a reference, the code itself stays in its pack. */
export const PYTHON_STRATEGY_SOURCE_PREFIX = 'psr-python-strategy:';

export function pythonStrategyRef(source: string): string | null {
  if (!source.startsWith(PYTHON_STRATEGY_SOURCE_PREFIX)) return null;
  const ref = source.slice(PYTHON_STRATEGY_SOURCE_PREFIX.length);
  return PYTHON_STRATEGY_REF_PATTERN.test(ref) ? ref : null;
}

/**
 * Python SDK strategy from a strategy pack (public examples or the owner's
 * private pack). Same accounts, markets and execution as Pine live Paper.
 */
export const PythonLivePaperSettingsV1Schema = z.object({
  accountModel: z.literal('python_live_v1'),
  strategyRef: z.string().regex(PYTHON_STRATEGY_REF_PATTERN),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.union([z.number().finite(), z.boolean(), z.string().max(200)])),
  ...liveSettingsShape,
}).strict().superRefine(validateLiveTracks);

export const PaperStrategySettingsSchema = z.union([
  LegacyPaperStrategySettingsSchema,
  VenueSharedPaperStrategySettingsSchema,
  VenueSharedPaperStrategySettingsV2Schema,
  PineLivePaperSettingsV1Schema,
  PythonLivePaperSettingsV1Schema,
]);

export type PaperStrategySettings = z.infer<typeof PaperStrategySettingsSchema>;
export type VenueSharedPaperStrategySettings = z.infer<typeof VenueSharedPaperStrategySettingsSchema>;
export type VenueSharedPaperStrategySettingsV2 = z.infer<typeof VenueSharedPaperStrategySettingsV2Schema>;
export type PineLivePaperSettingsV1 = z.infer<typeof PineLivePaperSettingsV1Schema>;
export type PythonLivePaperSettingsV1 = z.infer<typeof PythonLivePaperSettingsV1Schema>;
export type StrategyBacktestSettings = Omit<BacktestRequest, 'source'>;

export const StrategyCatalogMetadataSchema = z.object({
  description: z.string().max(2_000).optional(),
  origin: z.string().max(200).optional(),
  sourceReference: z.string().max(500).optional(),
  fidelity: z.string().max(200).optional(),
}).strict();

export type StrategyCatalogMetadata = z.infer<typeof StrategyCatalogMetadataSchema>;

function hasStrategyDeclaration(source: string): boolean {
  let executable = '';
  let quote: '"' | "'" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === '\n') {
      executable += '\n';
      lineComment = false;
      quote = null;
      continue;
    }
    if (lineComment) {
      executable += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        executable += '  ';
        index += 1;
      } else {
        executable += ' ';
      }
      continue;
    }
    if (quote !== null) {
      if (character === '\\' && next !== undefined) {
        executable += '  ';
        index += 1;
      } else {
        if (character === quote) quote = null;
        executable += ' ';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      executable += '  ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      executable += '  ';
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      executable += ' ';
      continue;
    }
    executable += character;
  }
  return /^\s*strategy\s*\(/m.test(executable);
}

const StrategyVersionDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().min(1).max(200_000),
  backtestSettings: z.record(z.string(), z.unknown()),
  paperSettings: PaperStrategySettingsSchema,
  metadata: StrategyCatalogMetadataSchema.default({}),
}).strict().superRefine((value, context) => {
  if (value.source.startsWith(PYTHON_STRATEGY_SOURCE_PREFIX)) {
    const ref = pythonStrategyRef(value.source);
    if (!ref) context.addIssue({ code: 'custom', path: ['source'], message: 'Python strategy reference must look like pack/module:Class.' });
    if (!('accountModel' in value.paperSettings) || value.paperSettings.accountModel !== 'python_live_v1'
      || value.paperSettings.strategyRef !== ref) {
      context.addIssue({ code: 'custom', path: ['paperSettings'], message: 'A Python strategy needs Python Paper settings for the same strategy.' });
    }
    if (Object.keys(value.backtestSettings).length > 0) {
      context.addIssue({ code: 'custom', path: ['backtestSettings'], message: 'Python strategies have no Pine backtest settings yet.' });
    }
    return;
  }
  if (!/^\s*\/\/\s*@version\s*=\s*[56]\s*$/m.test(value.source)) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Pine source must declare //@version=5 or //@version=6.' });
  }
  if (!hasStrategyDeclaration(value.source)) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Pine source must declare strategy(...), not indicator(...).' });
  }
  if (Object.hasOwn(value.backtestSettings, 'source')) {
    context.addIssue({ code: 'custom', path: ['backtestSettings', 'source'], message: 'Pine source must be stored only in source.' });
  }
  const backtest = BacktestRequestSchema.safeParse({ ...value.backtestSettings, source: value.source });
  if (!backtest.success) {
    for (const issue of backtest.error.issues) {
      if (issue.path[0] === 'source') continue;
      context.addIssue({ code: 'custom', path: ['backtestSettings', ...issue.path], message: issue.message });
    }
  }
});

export const CreateStrategySchema = StrategyVersionDraftSchema;
export const SaveStrategyVersionSchema = StrategyVersionDraftSchema.safeExtend({
  expectedVersion: z.number().int().positive(),
});

export type CreateStrategyInput = z.input<typeof CreateStrategySchema>;
export type SaveStrategyVersionInput = z.input<typeof SaveStrategyVersionSchema>;

export function normalizedBacktestSettings(input: Record<string, unknown>, source: string): StrategyBacktestSettings {
  // Python strategies (pack references) have no Pine backtest yet.
  if (pythonStrategyRef(source) !== null) return {} as StrategyBacktestSettings;
  const { source: parsedSource, ...settings } = BacktestRequestSchema.parse({ ...input, source });
  void parsedSource;
  return settings;
}

export interface StrategySummary {
  id: string;
  name: string;
  currentVersion: number;
  sourceSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyVersion {
  strategyId: string;
  version: number;
  name: string;
  source: string;
  sourceSha256: string;
  backtestSettings: StrategyBacktestSettings;
  paperSettings: PaperStrategySettings;
  metadata: StrategyCatalogMetadata;
  createdAt: string;
}

export interface StrategyDetail {
  strategy: StrategySummary;
  version: StrategyVersion;
}
