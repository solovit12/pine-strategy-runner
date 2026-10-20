# Live on Hyperliquid next to Lighter — engine plan (2026-10-19)

Status 2026-10-19: steps 1–10 done (offline tests pass), not deployed. Left: step 0 (read-only probe of the
owner's account after deployment), the first short Live run by the owner, and the open risks below.

Owner decisions: one Live run trades Lighter and Hyperliquid markets together; Live settings are
shared and applied per exchange; the daily loss limit is one percent evaluated per exchange (a bad
day halts only that exchange); Hyperliquid markets as in Paper (main perps and HIP-3 `xyz`, both
USDC); API wallet key + main account address (stage 1 done, `2ac9c5b`).

Further decisions (2026-10-19): faults caused by one exchange (its daily limit, position mismatch,
key refused, its exchange stop executed, refusals in a row) halt only that exchange; engine, pipe and
owner stops halt everything. Hyperliquid main + `xyz` count as one exchange for the daily limit. A
launch with `xyz` markets is refused while the `xyz` dex holds no collateral.

## Findings that would lose money if missed

1. An unfilled IOC on Hyperliquid arrives as `OrderRejected` "Order could not immediately match
   against any resting orders" (NT `common/enums.rs`, docs `hyperliquid.md` ~1160), not as
   accepted-then-canceled like Lighter. Today's classifier returns `unknown` → halt. Must be a
   normal no-fill miss.
2. Nautilus's Hyperliquid USDC balance is `totalRawUsd`/`withdrawable` of the main dex only
   (NT `common/parse.rs` ~1014, `execution.rs` ~528). It moves with position notional and omits
   the `xyz` dex collateral → cannot feed equity, leverage, `startBalance`, daily limit. Read
   equity from the info API (`clearinghouseState` per dex + `spotClearinghouseState`).
3. Counters keyed by market alone collide for SOL on both venues: `LiveRefusalPolicy.in_row` /
   `exit_misses`, `live_exchange_pnl`, `live_test_positions`/`live_test_pnl`, the position-check
   lookup, `lighter_positions`. Key them by track key (`spec.key`).

## Design

`apps/nautilus-paper/live_venues.py`: `LiveVenue` with `LighterVenue`, `HyperliquidVenue`,
`SandboxVenue(wraps a real venue's classifier)`. Each: `key`, `display`, `state_account`,
`load_credentials()`, `exec_client(builder, spec)`, `fetch_positions() -> {track_key: (qty, upnl)}`,
`fetch_equity()` (None → Nautilus balance), `classify(reason)`, `stop_fallback_bps`,
`sell_fit_margin_bps` (HL 2 bp: 5-significant-figure prices), `round_price`, `check_interval`,
`rate_limit_cooldown`.

Per-venue state `controller.live_venues[key]`: adapter, refusal policy, clean_checked,
start_balance, reference equity, exchange_pnl(+at), equity cache, `halted`.
`venue_halt(venue, reason)`: stop new orders for that venue, close its positions (existing close
loop), keep exchange stops on anything still open after 30 s, run stays `running`, snapshot account
row carries `halted`; all venues halted → `request_stop`. A venue whose day limit is used up at
start begins halted; launch refused only if all are. State file:
`{"accounts": {state_account: {period, equity, capturedAt}}}`, reads today's single-account shape.

Live socket handling: only `*-data-streams` drive data recovery; `hyperliquid-user-streams`
changes are logged only (the substring "hyperliquid" matches both today).

## Hyperliquid specifics (Nautilus rc7)

- IOC limit entries as now. `MARKET` = IOC limit at best bid/ask ± `market_order_slippage_bps`
  (per order via `SubmitOrder.params`, same key we send); needs a cached quote or `OrderDenied`.
- Reduce-only `STOP_MARKET` GTC → native `sl` trigger (`is_market=true`), limit = trigger ±
  slippage, 5 significant figures; triggers on the mark price.
- Config: `normalize_prices=True`, `include_builder_attribution=False`, `AccountId("HYPERLIQUID-001")`.
- Refusal groups (lowercase substring): miss — "could not immediately match", "no liquidity
  available for market order"; refused — "insufficient margin", "minimum value of $10",
  "reduce only order would increase", "open interest", "max position", "oracle", "away from the
  reference price", denials, "shutting down"; rate_limit — "too many", "rate limit"; key —
  "user or api wallet", "does not exist.", "invalid signature", "auth error"; nonce — "nonce";
  halt — "tick size", "invalid tp/sl price", "asset index not found", anything else. Unknown
  outcome after dispatch is only a log line → existing 30 s no-answer halt covers it.
- Minimum order value 10 USD (`min_notional`); keep the 1.15 reserve.
- Positions: info `clearinghouseState` (`dex` for `xyz`), `assetPositions[].position` `coin`
  ("SOL" / "xyz:NVDA"), signed `szi`, `unrealizedPnl`; clean start also `frontendOpenOrders` per dex.
- Market key `xyz:NVDA` ↔ `xyz:NVDA-USD-PERP.HYPERLIQUID` (`make_specs` already builds it).
- Leverage is set per asset in the Hyperliquid app; HIP-3 is isolated margin with collateral per
  dex: refuse to start `xyz` tracks when the `xyz` dex has no collateral.

## Steps

0. Read-only probe of the owner's account (`live_check.py`): account mode (`userAbstraction`),
   where USDC sits, equity/cash formula.
1. Re-key counters by track key (Lighter tests unchanged).
2. `live_venues.py`, move Lighter pieces into `LighterVenue` without behavior change; classifier tests.
3. Per-venue state (clean start, startBalance, reference, state file migration, equity per venue).
4. `venue_halt` + all-halted escalation; `halted` in snapshot, ledger schema, contracts.
5. Miss path for HL "could not immediately match".
6. `HyperliquidVenue`: credentials, exec client, info API positions/equity, price rounding, socket filter.
7. Two-venue offline sandbox tests (both enter; HL loss halts HL only and closes it while Lighter
   trades; HL miss exit retries; same-symbol counters separate; both halted stops the run).
8. Contracts: `validateLiveTracks` allows both venues.
9. API: `assertLive` requires each track venue in `liveExchanges()`; config `mode: 'real'`; messages.
10. Web: form offers connected exchanges; Live table per exchange with a `halted` badge.
11. Update `docs/LIVE_TRADING_DESIGN.md`; first short Live run by the owner.

## Open risks

- Gap close on HL prices off a stale cached quote; proposal: IOC limit from REST `l2Book` ± max slippage.
- Not verifiable offline: whether HL enforces a triggered stop's limit; whether reduce-only closes
  under 10 USD are refused; whether HL cancels a reduce-only stop on close (2 s grace covers it).
