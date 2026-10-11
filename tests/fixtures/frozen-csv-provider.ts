import { readFile } from 'node:fs/promises';
import type { Candle } from '../../packages/shared/src/contracts.js';

export interface MarketDataSnapshot {
  candles: Candle[];
  metadata: {
    sha256: string;
    missingBars: number;
    firstBar: string;
    lastBar: string;
  };
}

interface MetadataFile {
  csvSha256: string;
  missingBars: number;
  firstOpenTime: string;
  lastOpenTime: string;
}

export class FrozenCsvMarketDataProvider {
  #cache: Promise<MarketDataSnapshot> | null = null;

  constructor(
    private readonly csvPath: string,
    private readonly metadataPath: string,
  ) {}

  getSnapshot(): Promise<MarketDataSnapshot> {
    this.#cache ??= this.#load();
    return this.#cache;
  }

  async #load(): Promise<MarketDataSnapshot> {
    const [csv, metadataText] = await Promise.all([
      readFile(this.csvPath, 'utf8'),
      readFile(this.metadataPath, 'utf8'),
    ]);
    const lines = csv.trim().split(/\r?\n/);
    const candles = lines.slice(1).map((line, rowIndex) => {
      const row = line.split(',');
      if (row.length < 12) throw new Error(`Invalid candle row ${rowIndex + 2}`);
      const candle: Candle = {
        openTime: Number(row[0]),
        open: Number(row[2]),
        high: Number(row[3]),
        low: Number(row[4]),
        close: Number(row[5]),
        volume: Number(row[6]),
        closeTime: Number(row[7]),
        quoteAssetVolume: Number(row[8]),
        numberOfTrades: Number(row[9]),
        takerBuyBaseAssetVolume: Number(row[10]),
        takerBuyQuoteAssetVolume: Number(row[11]),
        ignore: 0,
      };
      if (!Number.isFinite(candle.openTime) || candle.low > candle.high || candle.open < candle.low || candle.close > candle.high) {
        throw new Error(`Invalid OHLC values at candle row ${rowIndex + 2}`);
      }
      return candle;
    });

    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index]!.openTime <= candles[index - 1]!.openTime) {
        throw new Error(`Candle timestamps are not strictly increasing at row ${index + 2}`);
      }
    }

    const metadata = JSON.parse(metadataText) as MetadataFile;
    return {
      candles,
      metadata: {
        sha256: metadata.csvSha256,
        missingBars: metadata.missingBars,
        firstBar: metadata.firstOpenTime,
        lastBar: metadata.lastOpenTime,
      },
    };
  }
}
