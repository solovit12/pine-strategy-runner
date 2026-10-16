import { z } from 'zod';

import {
  type PaperStrategySettings,
  PineLivePaperSettingsV1Schema,
  PineLiveTrackSchema,
  PythonLivePaperSettingsV1Schema,
  VenueSharedPaperStrategySettingsV2Schema,
} from './strategy-catalog-contracts.js';

/** The HTTP control plane never accepts executable Pine source from the browser. */
export const VenueSharedPaperLaunchSettingsV2Schema = VenueSharedPaperStrategySettingsV2Schema.safeExtend({
  hyperliquidMakerEntryFeePercent: z.number().finite().min(0).max(100),
  hyperliquidTakerExitFeePercent: z.number().finite().min(0).max(100),
  lighterMakerEntryFeePercent: z.number().finite().min(0).max(100),
  lighterTakerExitFeePercent: z.number().finite().min(0).max(100),
});

const launchTracks = z.array(PineLiveTrackSchema).min(1, 'Choose at least one market.').max(20);

/** Generic Pine Paper launch: every fee must be explicit. */
export const PineLivePaperLaunchSettingsV1Schema = PineLivePaperSettingsV1Schema.safeExtend({
  tracks: launchTracks,
  hyperliquidMakerFeePercent: z.number().finite().min(0).max(100),
  hyperliquidTakerFeePercent: z.number().finite().min(0).max(100),
  lighterMakerFeePercent: z.number().finite().min(0).max(100),
  lighterTakerFeePercent: z.number().finite().min(0).max(100),
});

/** Python strategy launch: every fee must be explicit. */
export const PythonLivePaperLaunchSettingsV1Schema = PythonLivePaperSettingsV1Schema.safeExtend({
  tracks: launchTracks,
  hyperliquidMakerFeePercent: z.number().finite().min(0).max(100),
  hyperliquidTakerFeePercent: z.number().finite().min(0).max(100),
  lighterMakerFeePercent: z.number().finite().min(0).max(100),
  lighterTakerFeePercent: z.number().finite().min(0).max(100),
});

export const StartPaperExperimentSchema = z.object({
  strategyId: z.uuid(),
  version: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  settings: z.union([VenueSharedPaperLaunchSettingsV2Schema, PineLivePaperLaunchSettingsV1Schema,
    PythonLivePaperLaunchSettingsV1Schema]),
  idempotencyKey: z.uuid(),
}).strict();

export type StartPaperExperimentRequest = z.infer<typeof StartPaperExperimentSchema>;

export type PaperExperimentStatus =
  | 'preparing'
  | 'waiting_for_data'
  | 'warming_up'
  | 'running'
  | 'recovering'
  | 'stopping'
  | 'completed'
  | 'interrupted';

export type PaperExperimentTrackStatus = PaperExperimentStatus;

/** Independent Paper experiments one API may run at once (each is its own Nautilus process). */
export const MAX_CONCURRENT_PAPER_EXPERIMENTS = 2;

/** Exchanges Live trading can connect to. */
export const LIVE_EXCHANGES = ['lighter'] as const;

/**
 * Live trading settings sent by the setup page. The API private key is write-only: the server
 * stores it on the machine that runs the engine and never returns it. Omitted: the saved key stays.
 */
export const SaveLiveSettingsSchema = z.object({
  exchange: z.enum(LIVE_EXCHANGES),
  enabled: z.boolean(),
  accountIndex: z.number().int().min(0).max(281_474_976_710_655),
  /** Lighter reserves 0–3 for its own apps; API keys use 4–254. */
  apiKeyIndex: z.number().int().min(4).max(254),
  apiKey: z.string().max(400).optional(),
}).strict();

export type SaveLiveSettingsRequest = z.infer<typeof SaveLiveSettingsSchema>;

export interface LiveSettingsView {
  readonly exchange: typeof LIVE_EXCHANGES[number];
  /** Live mode switched on by the owner. */
  readonly enabled: boolean;
  readonly accountIndex: number | null;
  readonly apiKeyIndex: number | null;
  /** A key is stored (its value is never returned). */
  readonly keySaved: boolean;
  /** 'app': saved from this page; 'server': a file the server operator placed. */
  readonly keySource: 'app' | 'server' | null;
  /** The server operator switched Live off (PSR_LIVE_DISABLED=1). */
  readonly disabledByServer: boolean;
}

/** Read-only connection check of the saved Lighter account (no orders). */
export interface LiveConnectionCheck {
  readonly ok: boolean;
  readonly balance: string | null;
  readonly openPositions: number;
  readonly openOrders: number;
  readonly error: string | null;
}

/** Only one Live run at a time: two engines would share one Lighter account and API key. */
export const LIVE_ALREADY_ACTIVE_MESSAGE = 'A LIVE run is already active. Stop it before starting another LIVE run.';

export interface PaperExperimentCapabilities {
  readonly available: boolean;
  readonly reason: string | null;
  readonly maxTracksPerVenue: number;
  readonly maxTracksPerExperiment: number;
  readonly maxConcurrentExperiments: number;
  /** Runs holding a slot now; with maxConcurrentExperiments it explains a full server calmly. */
  readonly activeExperiments?: number;
  /** Optional server-enforced pilot market subset; absent for the general draft. */
  readonly allowedMarkets?: readonly string[];
  /** Live trading with real money on Lighter is enabled on this engine (full edition, PSR_LIVE_ENABLED=1). */
  readonly liveTrading?: boolean;
  /** A Live run is active: only one at a time (one Lighter account and API key). */
  readonly liveActive?: boolean;
}

export interface PaperExperimentTrack {
  readonly trackId: string;
  /** One account/run is shared by all market tracks at this venue. */
  readonly accountId: string;
  readonly runId: string;
  readonly venue: 'Hyperliquid' | 'Lighter';
  readonly market: string;
  readonly status: PaperExperimentTrackStatus;
  readonly reason: string | null;
  readonly updatedAt: string;
  readonly events: number;
  readonly signals: number;
  readonly intents: number;
  readonly fills: number;
}

export interface PaperExperimentAccount {
  readonly venue: 'Hyperliquid' | 'Lighter';
  readonly accountId: string;
  readonly runId: string;
  readonly currency: 'USDC';
  readonly startingCash: number;
}

export interface PaperExperimentSummary {
  readonly id: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly strategyName: string;
  readonly sourceSha256: string;
  readonly status: PaperExperimentStatus;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly trackCount: number;
  /** Pinned launch characteristics for the history table. */
  readonly venues?: readonly PaperExperimentAccount['venue'][];
  readonly markets?: readonly PaperExperimentTrack['market'][];
  readonly timeframe?: PaperStrategySettings['timeframe'];
  readonly capitalPerVenue?: number | null;
  /** True for a Live run (real orders on Lighter). */
  readonly live?: boolean;
}

export interface PaperExperimentDetail extends PaperExperimentSummary {
  readonly accountModel: 'python_live_v1' | 'pine_live_v1' | 'venue_shared_v2' | 'venue_shared_v1' | 'legacy_per_track';
  readonly settings: PaperStrategySettings;
  readonly accounts: readonly PaperExperimentAccount[];
  readonly tracks: readonly PaperExperimentTrack[];
  /** Live owner observation; absent after a process death or on older runs. */
  readonly runtime?: PaperExperimentRuntimeView;
}

export interface PaperExperimentRuntimeView {
  readonly stage: 'warming_up' | 'waiting_for_data' | 'running' | 'recovering' | 'stopping';
  /** Present only when the current owner attests the Nautilus Sandbox engine. Older snapshots omit it. */
  readonly engine?: 'nautilus';
  readonly fundingTreatment: 'excluded';
  readonly observedAt: string;
  /** Per-market observations; older one-market snapshots omit this list. */
  readonly tracks?: readonly {
    readonly venue: PaperExperimentAccount['venue'];
    readonly market: string;
    readonly publicFrames: number;
    readonly pendingOrders: number;
    readonly signals: number;
    readonly intents: number;
    readonly fills: number;
    readonly rejectedSignals: number;
    readonly priceReady: boolean;
    readonly stalePriceObservationsSkipped: number;
    /** Present while this market waits for fresh data after a gap; other markets keep trading. */
    readonly dataGap?: { readonly sinceMs: number; readonly connected: boolean; readonly resubscribes: number };
  }[];
  readonly accounts: readonly {
    readonly venue: PaperExperimentAccount['venue'];
    readonly accountId: string;
    readonly runId: string;
    readonly cashBalance: string;
    readonly brokerRevision: number;
    readonly publicFrames: number;
    readonly pendingOrders: number;
    readonly signals: number;
    readonly intents: number;
    readonly fills: number;
    readonly rejectedSignals: number;
    /** Whether every selected market at this venue has usable prices at observedAt. */
    readonly priceReady?: boolean;
    /** Price observations skipped because the one-second quote gate had expired. */
    readonly stalePriceObservationsSkipped?: number;
    readonly positions: readonly {
      readonly market: string;
      readonly side: 'long' | 'short';
      readonly remainingBaseQuantity: string;
      /** Average entry price of the open position (Nautilus Sandbox). */
      readonly avgEntryPrice?: string;
      /** Mid price used for the unrealized PnL at observedAt. */
      readonly markPrice?: string;
      /** Unrealized PnL at markPrice, before exit fees. */
      readonly unrealizedPnl?: string;
      readonly openedAt?: string;
    }[];
  }[];
}

/** A concise timeline reconstructed from persisted control milestones and Broker commits. */
export interface PaperExperimentActivityEvent {
  readonly id: string;
  readonly at: string | null;
  readonly kind: 'created' | 'started' | 'status' | 'stopped' | 'signal' | 'fill';
  readonly venue?: PaperExperimentAccount['venue'];
  readonly market?: string;
  readonly message: string;
}

/** One durably committed simulated Broker fill, not a completed round-trip trade. */
export interface PaperExperimentActivityFill {
  readonly id: string;
  readonly at: string | null;
  readonly venue: PaperExperimentAccount['venue'];
  readonly market: string;
  readonly kind: 'entry' | 'exit';
  readonly side: 'buy' | 'sell';
  readonly positionSide: 'long' | 'short';
  readonly quantity: string;
  readonly quote: string;
  /** Quantity-weighted price, rounded to 12 decimals; null if not derivable. */
  readonly price: string | null;
  /** Fee computed from the pinned Broker manifest's exact fee rate. */
  readonly fee: string | null;
  /** Reserved until a complete net-PnL attribution is available. */
  readonly realizedPnl: string | null;
}

export interface PaperExperimentActivity {
  readonly events: readonly PaperExperimentActivityEvent[];
  readonly eventCoverage: 'key_milestones';
  readonly fills: readonly PaperExperimentActivityFill[];
  /** Exact across both venue journals only when coverage is durable_journal. */
  readonly totalFills: number | null;
  readonly nextFillsCursor: string | null;
  readonly coverage: 'durable_journal' | 'control_only' | 'partial';
}
