# Hyperliquid public market data research

Verified against official Hyperliquid documentation on 2026-09-07. This note records adapter facts for the venue-neutral paper market data contract. It is not a latency, completeness, execution, or profitability claim.

The initial worker is deliberately **perpetual-only**. Its configured market metadata is validated at startup and any `spot` instrument is rejected before sockets or subscriptions are created. The shared venue-neutral contract retains `spot` as a future adapter capability, but spot channel planning is not part of this first worker.

## Official public interfaces

The official [WebSocket subscriptions documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) defines public subscriptions for `trades`, `l2Book`, `bbo`, `candle`, and `activeAssetCtx`. A client sends a JSON `subscribe` request with one subscription object and receives channel-specific payloads.

The same page defines these relevant response shapes:

- `trades`: an array of trades. Each trade includes `coin`, taker `side`, string `px`, string `sz`, `hash`, millisecond `time`, integer `tid`, and the participating users. The documentation says `(block_time, coin, tid)` forms a globally unique trade id.
- `bbo`: `coin`, millisecond `time`, and a two-element `[bid, ask]` tuple whose sides may individually be null. A level contains string `px`, string `sz`, and order count `n`.
- `l2Book`: `coin`, two arrays of levels (`bids`, `asks`), and millisecond `time`. A level contains string `px`, string `sz`, and order count `n`.
- `candle`: candle fields include open time `t`, close time `T`, symbol `s`, interval `i`, string OHLC values, string volume `v`, trade count `n`, and start time of the interval `t`.
- `activeAssetCtx`: a coin plus the current perpetual asset context; the documented context contains string `funding` and `markPx` values.

The official [Info endpoint documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) independently documents L2 snapshot and candle snapshot response fields. It also documents venue-specific asset naming, including spot `@index` names and HIP-3 `dex:SYMBOL` names. The adapter must resolve these identities from metadata instead of assuming every market name is a plain perpetual ticker.

## L2 book is a replacement snapshot, not a delta stream

This is the central venue difference.

The official WebSocket type is named `WsBook` and described as **order book snapshot updates**. Its complete documented payload is:

- `coin`;
- `levels`, with one bid array and one ask array;
- `time`.

There is no `nonce`, `sequence`, `previous sequence`, update id, or delta operation in that official `WsBook` schema. Therefore:

1. Every accepted `l2Book` message replaces the prior visible book for that subscription.
2. The adapter emits `snapshotKind: "full"` and `continuity.mode: "full_snapshot"`.
3. `source.venueSequence`, `continuity.venueSequence`, and `continuity.previousVenueSequence` are all `null`.
4. The adapter must not copy Lighter nonce logic, invent a local value and label it a venue sequence, or apply a Hyperliquid snapshot as a delta.

The official WebSocket comments state that the snapshot is pushed on an eligible block at least 0.5 seconds after the prior push. The subscription accepts an optional `nSigFigs` aggregation and optional `mantissa`; it also accepts `fast`, documented as five levels when true versus twenty levels when false. The official Info endpoint states that its REST L2 snapshot returns at most twenty levels per side.

In our contract, **full snapshot** means the complete replacement content delivered for the selected subscription depth. It does not mean every resting order at every price on the exchange.

### What can and cannot be proven without a nonce

A socket disconnect, local queue overflow, parser rejection, stale deadline, or connection-epoch change is observable and must invalidate the source. A fresh accepted book snapshot can then restore current visible book state.

A missing WebSocket book update cannot be proven from a venue nonce because the payload has no nonce. Time jumps can support a staleness alarm but are not an exact message-count proof. The adapter must report this honestly: `connection_lost`, `stale`, `schema_error`, or a local overload gap, not a fabricated Hyperliquid `sequence_gap`.

## Normalization decisions

| Hyperliquid source | Venue-neutral output | Required handling |
| --- | --- | --- |
| Each element of `trades` | One `trade` event | Preserve array order; normalize `B` to aggressor `buy` and `A` to aggressor `sell`; build a stable id without decimal conversion. |
| `bbo` | One `bbo` event | Preserve a venue-reported missing side as `null` and replace any older quote. If both sides exist, require a strictly positive spread. A one-sided or empty quote is valid current state but is not executable. |
| `l2Book` | One `book_snapshot` event | Replace all prior visible levels, including with an empty side; validate sort order, uniqueness, positive values, and an uncrossed top when both sides exist. An empty-sided snapshot is valid current state but is not executable. |
| Candle payload | One new `candle` update, plus a cached close when rollover is proven | Preserve string OHLC/volume. On a valid same-epoch rollover, emit the cached candle as `closed` before the new `update`; never synthesize a close across a gap. |
| `activeAssetCtx.ctx.funding` | One `funding_rate` event | Perpetuals only; preserve the current rate as a decimal fraction string and label it `rateType: "current"`, `unit: "fraction"`. |
| Connection/subscription state | `source_status` | Publish initial sync, reconnect, stale, schema drift, overload, recovery, ready, close, and failure transitions. |

Do not convert venue decimal text through JavaScript `number` and then stringify it. That can change prices, quantities, or small funding rates. Validate and retain canonical decimal strings.

Here `valid` means that the adapter trusts the current venue state and its delivery continuity. It does not mean that a paper fill is possible. The later Paper Broker must independently require both needed sides, a positive spread, and sufficient current depth before simulating execution.

## Candle envelope compatibility note

The official WebSocket page currently types the candle subscription payload as `Candle[]`. A live payload checked during this implementation was a single candle object rather than an array. These facts must not be blurred:

- official documentation: array-typed candle data;
- current live observation: one object;
- venue-neutral output: one new `candle` update per candle object; a valid rollover additionally releases the prior cached candle as `closed` before that update.

The adapter may explicitly support both validated envelopes if this is covered by tests. It must not silently take element zero, flatten arbitrary objects, or accept an unknown shape. Any other envelope is schema drift and triggers an invalid `source_status` until recovery.

A candle is `state: "closed"` only with unambiguous close evidence. A local wall-clock boundary alone is never evidence. This adapter's explicit rule is: inside the same admitted connection epoch with no gap or schema failure, a newer valid candle whose `openTimeMs` is later than the cached candle's `closeTimeMs` confirms the cached candle's close. The worker emits that cached candle as `closed` before the new `update`, using distinct increasing source sequences. On reconnect, overload, staleness, or schema failure it clears the provisional candle and emits no synthetic close. The configured interval is part of subscription identity; a different payload interval is rejected, cannot count as fresh, and triggers reconnect recovery.

## Connection health and recovery

The official [WebSocket timeouts and heartbeats documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats) says the server closes a connection that receives no message from the client for 60 seconds. A client can send `{ "method": "ping" }` and receives a `pong` response.

Worker rules:

1. Capture wall-clock and monotonic receipt times at the WebSocket callback boundary.
2. Use a bounded queue and measure its occupancy/lag.
3. Never silently drop required trades or candle closes.
4. On disconnect or overload, publish a non-valid status and stop admitting affected data to paper fills.
5. Keep the same logical `connectionId` on reconnect and create a new `connectionEpoch` for the new socket lifetime.
6. Resubscribe, publish the fresh valid replacement state while the source remains `recovering`, and publish `ready` last as the activation boundary for book-dependent consumers. Only replaceable current state (`l2Book`, `bbo`, or `activeAssetCtx` funding) may be a required recovery barrier. Trades and candles are withheld during recovery and can never open `ready` or retroactively repair their missing interval. The default barrier is fresh `l2Book`.
7. Treat `pong` as connection health, not market freshness. Each configured required replacement channel also needs its own staleness deadline.
8. On a terminal runtime failure, emit `failed` for each real affected connection and its current epoch. Keep synthetic runtime labels in diagnostics only; do not publish a phantom contract connection.

Hyperliquid's absence of a book nonce makes connection and local-ingress observability more important, not less.

## Published connection limits

The official [rate-limits documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) publishes these WebSocket ceilings: 10 simultaneous connections, 30 new connections per minute, 1,000 subscriptions, and 2,000 client-sent messages per minute. The transport therefore uses at most eight logical connections, groups all five channels of one market on one shard, and keeps rolling safety limits below the venue ceilings. Reconnects and heartbeat pings count against the same bounded outbound budget; a reconnect storm must wait instead of repeatedly hammering the endpoint.

Each logical WebSocket shard has its own bounded Node Worker thread and its own input, control, and output credits. A hot shard cannot consume another shard's queue. A socket-ingress overload is a reconnectable gap for that shard and requires a newer epoch plus fresh-state gating. A terminal Worker failure remains `failed`. The current observation runner deliberately ends the whole observation on any rejected live frame or terminal Worker failure; it does not yet restart one Worker in place. This is queue isolation, not a claim of independent experiment survival or total order. A later gateway may choose a per-shard restart policy, but it must retain the per-worker/per-connection ordering rules in the common contract.

## Qualification scope

This research note establishes payload semantics, not achieved performance. The separate technical acceptance (removed 2026-10-06; see Git history) records the completed local evidence for:

- schema fixtures for every supported channel and every supported envelope;
- JSON contract validation and exact decimal preservation;
- reconnect and fresh-snapshot recovery;
- stale-channel detection even while the socket remains alive;
- bounded-queue behavior under synthetic overload;
- deterministic invalidation with no silent event loss;
- sustained throughput and p95/p99 ingress-to-normalization latency on the intended host;
- behavior when one symbol or channel is disproportionately busy.

Execution/fill latency is outside this public-data contract. The accepted checks prove only that the market-data boundary is technically usable for paper evaluation within its recorded load boundary; they do not qualify paper execution, a strategy, profitability, or another host.

## Official sources

- [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Hyperliquid WebSocket timeouts and heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats)
- [Hyperliquid rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
