# Lighter public market-data source

Checked on 2026-09-08 against the official Lighter API documentation and the
previous isolated paper observer. This note defines the source boundary for the
universal paper market-data worker. It does not authorize or describe private
account access or order submission.

## Public endpoints

- Mainnet metadata REST: `https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails`.
- Mainnet WebSocket: `wss://mainnet.zklighter.elliot.ai/stream?readonly=true`.
- The worker uses public perpetual markets only.

References:

- <https://apidocs.lighter.xyz/docs/websocket-reference>
- <https://apidocs.lighter.xyz/docs/rate-limits>
- <https://apidocs.lighter.xyz/reference/orderbookdetails>

## Shared event mapping

| Lighter subscription | Shared event | Important source rule |
| --- | --- | --- |
| `trade/{market_id}` | `trade` | `subscribed/trade` is initial history and is not live output |
| `ticker/{market_id}` | `bbo` | ask and bid retain decimal text |
| `order_book/{market_id}` | `book_snapshot` | initial snapshot, then atomic deltas reconstructed into a full current snapshot |
| `candle/{market_id}/{resolution}` | `candle` | preserve numeric lexemes; classify the current interval as `update` |
| `market_stats/{market_id}` | `funding_rate` | use `current_funding_rate`; output is a fraction, not a display percentage |

All five subscriptions for one market stay on the same logical shard. One
hundred markets therefore require 500 subscriptions. Eight shards own the
markets round-robin, while one process-wide outbound limiter protects the venue
IP limit.

## Continuity and recovery

The first `order_book` payload is a complete state. Later payloads are deltas.
A delta is admissible only when its `begin_nonce` exactly equals the previously
committed `nonce`. `offset` is never used as a continuity proof.

The state update is atomic:

1. validate the complete message without changing the live state;
2. apply every bid and ask to the full internal price map and sorted index while
   recording a bounded undo log;
3. delete a price when its size is zero;
4. verify ordering, positive remaining quantities, level limits and uncrossed
   best prices;
5. on failure, replay the undo log so the previous state is exact; on success,
   publish only the current top 20 levels per side as one replacement snapshot.

If any step fails, no partial book is visible. The whole shard becomes invalid,
the connection is replaced with a newer epoch, and no market on that shard is
ready until it has a fresh valid book state.

## Transport limits

The process uses one rolling limiter for every shard. The safety default is
lower than the documented 200 client messages per minute and includes
subscriptions and application heartbeat messages. A 100-market cold start is
therefore intentionally gradual and takes about three minutes.

Receipt wall time and monotonic time are stamped at the WebSocket callback
boundary, before JSON parsing. The socket disables `permessage-deflate` so CPU
spent inflating frames cannot silently enlarge ingress latency. Unsupported
frames, missing acknowledgements, queue saturation, stale channels, nonce gaps
and late frames from an older epoch all fail closed.

The parser keeps the common path fast without sacrificing exact numbers. It
uses native JSON only when a lexical pass proves that every unquoted number is
a safe integer and that the parsed object contains exactly as many keys as the
wire text (so duplicate keys are rejected, including escaped spellings). A
decimal, exponent or unsafe integer routes the whole frame through the exact
lossless-number parser. The normalization completion timestamp is assigned only
after the complete message has been applied to state.

Each shard owns one bounded Worker thread. A runtime cycle admits exactly one
Lighter ingress item because one legal trade message may expand into 4,096
ordered events. The thread immediately drains that atomic result, combines only
small adjacent results into parent batches of at most 32 items and four MiB,
and publishes the batch before acknowledging the corresponding input. This
keeps the large-message bound while avoiding one cross-thread callback for every
ordinary one-event frame. If the parent does not acknowledge the oldest output
batch before its deadline, publication fails closed instead of silently growing
memory or extending that deadline with newer batches.

## Explicit exclusions

This adapter does not contain signal logic, a strategy, paper fills, fees,
latency simulation, PnL, a database, raw retention, account credentials,
signing, private API calls or real orders. Those responsibilities belong to
later layers.
