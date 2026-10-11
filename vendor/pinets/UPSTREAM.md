# Controlled PineTS source fork

- Upstream: `https://github.com/LuxAlgo/PineTS`
- Upstream version: `0.11.0` (tag `v0.11.0`)
- Upstream commit: `c5e6b0efee7e42d78b42d96f14173f38be082551`
- License: `AGPL-3.0-only` (see `LICENSE`)
- Local fork version: `0.11.0-pine-strategy-runner.1`
- Previous base: `0.9.33` (`493a410`); upgraded 2026-10-11. Upstream's own pending-entry
  replacement rule (0.11.0) replaced our earlier variant; upstream docs and tests are
  not vendored (only the fork's tests below).

This directory is the auditable source fork used by Pine Strategy Runner. It
adds an opt-in broker-replay hook and directed High replay execution while
preserving PineTS's ordinary parent-OHLC path when the hook is not installed.

High replay:

- never executes the Pine body for a replay point;
- mutates PineTS's existing `context.strategy` ledger;
- uses the existing position, commission and trade accounting functions;
- gives limit orders price improvement on gaps and no slippage;
- gives stop/market orders adverse slippage;
- orders crossings by the directed segment and gives exits priority at equal
  trigger prices;
- emits deterministic fill/cancel audit records.
- exposes read-only pending-order capability metadata to the product adapter;
- reports required margin and whether each replay point would require a
  margin call, without performing an unqualified High liquidation.

`dist/` is not checked in: `scripts/ensure-pinets-build.mjs` builds it from this
source with `npm run build:prod:all` when the source changes. The fork's focused tests are
under `tests/namespaces/strategy/`.

To run the full upstream suite with the fork, check out the upstream tag, apply
the fork's source changes and run `npm ci && npm test` there (2026-10-11: 2765
passed, including the fork's tests).

Gate H4 rejects stop-limit, trailing and partial-exit orders before replay and
stops when a replay point would require a margin call. The public app continues
to use Default until TradingView qualification is complete.
