# Nautilus Paper engine

The Paper engine runs a Pine strategy on live public prices from Hyperliquid and
Lighter and executes its orders in virtual accounts. It uses Nautilus Trader
Sandbox accounts, never exchange order clients: no exchange keys are needed and
no real order is ever placed.

The API owns each experiment and starts one child process per run with
`--config PATH`. The Pine strategy itself runs in the API (PineTS); at every bar
close the API sends the strategy's order set to this process, which executes it
against the current order book and reports each fill back.

## Execution model

- **Arrival time.** An order is evaluated when it would reach the exchange:
  200 ms after its trigger for an entry, 300 ms for an exit, against the latest
  known book.
- **Immediate-or-cancel orders.** Visible size at or better than the price is
  filled; the remainder is canceled. Exits are reduce-only.
- **Fees.** Each exchange account pays its own maker/taker rates; Hyperliquid
  HIP-3 markets (`xyz:NVDA`) pay their deployer's rate. Funding is excluded.
- **One account per exchange.** All markets of an exchange share one virtual
  account, its cash and its positions.

## Freshness and recovery

Exchanges publish only changes, so a quiet market is not stale by itself. A
market is current while its exchange connection keeps delivering messages.

When a connection drops, both accounts pause: no order executes against an old
book. The same process, accounts and positions stay alive while the client
reconnects. The run resumes after a complete new book for every selected
market and an account check. An order set that arrived during the pause
executes on the first fresh price afterwards; missed trades are not replayed.

## Process protocol

The child reads newline-delimited JSON commands on stdin (`pine_orders`,
`snapshot`, `stop`; offline test configs also accept `socket` and `frame`) and
writes one `PSR_EVENT=` JSON envelope per stdout line. Each envelope carries
`v`, a contiguous `seq`, `at`, `runId` and a `type` (`phase`, `snapshot`,
`event`, `fill`, `pine_fill`, `failure`, `stopped`). Every envelope is appended
and fsynced to the run's `nautilus-events.jsonl` outbox before stdout, so the
API can recover an unread tail after a crash.

## Tests

The offline tests use a real Nautilus Sandbox with synthetic prices and no
network:

```bash
python apps/nautilus-paper/test_pine_runtime.py
python apps/nautilus-paper/test_pine_recovery.py
python apps/nautilus-paper/test_lifecycle.py
```

Set `PSR_NAUTILUS_PYTHON` to the interpreter of the pinned Nautilus build.
