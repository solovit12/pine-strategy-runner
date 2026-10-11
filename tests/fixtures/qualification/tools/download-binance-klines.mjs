#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERVAL_MS = new Map([["1h", 60 * 60 * 1000]]);
const DEFAULT_START = "2024-12-31T23:00:00Z";
const DEFAULT_END = "2026-09-01T02:00:00Z";
const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1h";
const DEFAULT_BASE_URL = "https://data-api.binance.vision";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function parseUtc(value, label) {
  if (!value.endsWith("Z")) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp ending in Z`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} is not a valid timestamp: ${value}`);
  }
  return milliseconds;
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        return await response.json();
      }
      const body = await response.text();
      lastError = new Error(`Binance returned HTTP ${response.status}: ${body.slice(0, 300)}`);
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

function validateKline(row, intervalMs) {
  if (!Array.isArray(row) || row.length < 11) {
    throw new Error("Malformed kline row");
  }
  const openTime = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const closeTime = Number(row[6]);
  const quoteVolume = Number(row[7]);
  const trades = Number(row[8]);
  const takerBase = Number(row[9]);
  const takerQuote = Number(row[10]);

  if (closeTime < openTime || closeTime > openTime + intervalMs - 1) {
    throw new Error(`Unexpected close time at ${new Date(openTime).toISOString()}`);
  }
  if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`Invalid OHLC value at ${new Date(openTime).toISOString()}`);
  }
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    throw new Error(`Invalid OHLC relationship at ${new Date(openTime).toISOString()}`);
  }
  if (![volume, quoteVolume, takerBase, takerQuote].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error(`Invalid volume at ${new Date(openTime).toISOString()}`);
  }
  if (!Number.isInteger(trades) || trades < 0) {
    throw new Error(`Invalid trade count at ${new Date(openTime).toISOString()}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const symbol = (args.symbol ?? DEFAULT_SYMBOL).toUpperCase();
const interval = args.interval ?? DEFAULT_INTERVAL;
const intervalMs = INTERVAL_MS.get(interval);
if (intervalMs == null) {
  throw new Error(`Unsupported interval: ${interval}. This qualification tool currently supports only 1h.`);
}

const startIso = args.start ?? DEFAULT_START;
const endIso = args.end ?? DEFAULT_END;
const startMs = parseUtc(startIso, "start");
const endMs = parseUtc(endIso, "end");
if (endMs <= startMs || startMs % intervalMs !== 0 || endMs % intervalMs !== 0) {
  throw new Error("The range must be positive and aligned to complete UTC hours");
}

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(args.output ?? path.join(toolDir, "..", "data", "binance-btcusdt-1h-20241231T230000Z-20260901T020000Z.csv"));
const metadataPath = outputPath.replace(/\.csv$/i, ".metadata.json");
const baseUrl = (args["base-url"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const rowsByOpenTime = new Map();

for (let cursor = startMs; cursor < endMs;) {
  const url = new URL("/api/v3/klines", baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(cursor));
  url.searchParams.set("endTime", String(endMs - 1));
  url.searchParams.set("limit", "1000");

  const page = await fetchJson(url);
  if (!Array.isArray(page) || page.length === 0) {
    throw new Error(`Binance returned no data from ${new Date(cursor).toISOString()}`);
  }
  for (const row of page) {
    const openTime = Number(row[0]);
    if (openTime >= startMs && openTime < endMs) {
      rowsByOpenTime.set(openTime, row);
    }
  }
  const nextCursor = Number(page.at(-1)[0]) + intervalMs;
  if (nextCursor <= cursor) {
    throw new Error("Binance pagination did not advance");
  }
  cursor = nextCursor;
}

const rows = [...rowsByOpenTime.values()].sort((left, right) => Number(left[0]) - Number(right[0]));
const expectedRows = (endMs - startMs) / intervalMs;
if (rows.length === 0 || Number(rows[0][0]) !== startMs || Number(rows.at(-1)[0]) !== endMs - intervalMs) {
  throw new Error("The downloaded data does not cover the requested first and last bar");
}
rows.forEach((row) => validateKline(row, intervalMs));
const closeTimeAnomalies = rows.filter((row) => Number(row[6]) !== Number(row[0]) + intervalMs - 1).map((row) => ({
  openTime: new Date(Number(row[0])).toISOString(),
  closeTime: new Date(Number(row[6])).toISOString(),
  volume: String(row[5])
}));
const gaps = [];
for (let index = 1; index < rows.length; index += 1) {
  const previous = Number(rows[index - 1][0]);
  const current = Number(rows[index][0]);
  const difference = current - previous;
  if (difference <= 0 || difference % intervalMs !== 0) {
    throw new Error(`Invalid bar ordering near ${new Date(current).toISOString()}`);
  }
  if (difference > intervalMs) {
    gaps.push({
      after: new Date(previous).toISOString(),
      resumesAt: new Date(current).toISOString(),
      missingBars: difference / intervalMs - 1
    });
  }
}
const missingBars = gaps.reduce((sum, gap) => sum + gap.missingBars, 0);
const allowGaps = args["allow-gaps"] === "true";
if (gaps.length > 0 && !allowGaps) {
  throw new Error(`Expected ${expectedRows} hourly klines, received ${rows.length}; ${missingBars} exchange bars are absent. Re-run with --allow-gaps true only when real exchange gaps must be preserved.`);
}

const header = [
  "open_time_ms",
  "open_time_utc",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "close_time_ms",
  "quote_asset_volume",
  "trade_count",
  "taker_buy_base_volume",
  "taker_buy_quote_volume"
];
const csvRows = rows.map((row) => [
  row[0],
  new Date(Number(row[0])).toISOString(),
  row[1],
  row[2],
  row[3],
  row[4],
  row[5],
  row[6],
  row[7],
  row[8],
  row[9],
  row[10]
].map(csvCell).join(","));
const csv = `${header.join(",")}\n${csvRows.join("\n")}\n`;
const csvSha256 = crypto.createHash("sha256").update(csv).digest("hex");
const metadata = {
  schemaVersion: 1,
  source: `${baseUrl}/api/v3/klines`,
  documentation: "https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md",
  symbol,
  interval,
  timezone: "UTC",
  startInclusive: new Date(startMs).toISOString(),
  endExclusive: new Date(endMs).toISOString(),
  expectedRows,
  rows: rows.length,
  firstOpenTime: new Date(Number(rows[0][0])).toISOString(),
  lastOpenTime: new Date(Number(rows.at(-1)[0])).toISOString(),
  continuous: gaps.length === 0,
  missingBars,
  gaps,
  closeTimeAnomalies,
  csvSha256,
  fetchedAtUtc: new Date().toISOString()
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
await fs.writeFile(temporaryPath, csv, "utf8");
await fs.rename(temporaryPath, outputPath);
await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, metadataPath, ...metadata }, null, 2));
