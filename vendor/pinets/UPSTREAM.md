# Controlled PineTS source fork

- Upstream: `https://github.com/LuxAlgo/PineTS`
- Upstream version: `0.9.33`
- Upstream commit: `493a410270b83f94d7504b2eb979deb777e8ced7`
- License: `AGPL-3.0-only` (see `LICENSE`)
- Local fork version: `0.9.33-pine-strategy-runner.h4.1`

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

The checked-in `dist/pinets.min.*` and `dist/types` files were built from the
checked-in source with `npm run build:prod:all`. The fork's focused tests are
under `tests/namespaces/strategy/`.

The install-facing `package.json` intentionally omits fork build-only
dependencies so npm does not merge PineTS's Vitest 4 peer graph into the root
application's Vitest 5 graph. For an isolated rebuild, copy this directory to
a temporary location, replace its `package.json` with `package-build.json`, run
`npm ci`, then run the focused tests and `npm run build:prod:all` there.

Gate H4 rejects stop-limit, trailing and partial-exit orders before replay and
stops when a replay point would require a margin call. The public app continues
to use Default until TradingView qualification is complete.
