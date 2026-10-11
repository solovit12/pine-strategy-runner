# Pine runtime research

Date: 2026-09-05

## Outcome

The feasibility result is **good**: more than one self-hosted runtime can accept Pine Script v5/v6 source and produce strategy state without TradingView alerts or webhooks.

The trading-correctness result is **inconclusive**: the local checks below validate upstream test suites, not trade-for-trade parity against our own TradingView exports. The product must not claim TradingView parity until the qualification gate in this document passes.

**Recommendation:** use [PineTS](https://github.com/LuxAlgo/PineTS) as the first runtime candidate behind a product-owned `PineRuntime` adapter. Keep [Resin](https://github.com/nullarch/resin) as the permissively licensed challenger. Do not make either runtime a direct dependency of the UI, market-data adapter, portfolio model, or future exchange execution layer.

## Candidate comparison

| Candidate | Direct `.pine` input | Strategy support | Realtime path | License | Decision |
| --- | --- | --- | --- | --- | --- |
| PineTS 0.9.33 | Native v5/v6 source | Broad `strategy.*` surface, trades, orders and metrics | `stream()` is documented | AGPL-3.0-only package, with a separate commercial license offered upstream | **Primary qualification candidate** |
| Resin 0.2.2 | Native v5/v6 source | Entries, exits, pyramiding and strategy state | Caller-controlled per-bar execution | Apache-2.0 | **Challenger/fallback**; backtest parity is still provisional |
| PyneCore 6.9.0 | Not fully self-hosted for `.pine` | Mature Python strategy and live framework | Live provider and broker model | Apache-2.0 runtime | **Reject for the core flow** because Pine-to-Python compilation requires a PyneSys API key |
| Backtest Kit 18.8.0 | Through its PineTS integration | Backtest/paper/live framework | Yes | MIT core; Pine integration still brings PineTS/AGPL | **Reference only** for temporal isolation and execution architecture |
| OpenPineScript 0.0.1 | Only v1/v2 are documented as implemented | Broker emulator exists for implemented versions | Tick model exists for implemented versions | GPL-3.0 | **Reject for MVP** because real target scripts are v5/v6 |
| PineForge | Native v6 through a separate transpiler | Strong engine and published parity evidence | Backtest oriented | Engine Apache-2.0; transpiler PolyForm Noncommercial/source-available | **Reject for this open-source product** because the full compiler path is not OSI open source for product embedding |

### PineTS

Why it leads:

- It is TypeScript and accepts native Pine v5/v6 source in-process, which matches the proposed end-to-end stack.
- The upstream [strategy documentation](https://github.com/LuxAlgo/PineTS/blob/main/docs/strategy.md) exposes orders, trades, portfolio state, metrics and runtime input overrides. The [strategy coverage table](https://github.com/LuxAlgo/PineTS/blob/main/docs/api-coverage/strategy.md) lists the implemented surface.
- It accepts caller-supplied OHLCV arrays, so our `MarketDataProvider` can remain independent from Binance and PineTS providers.
- The repository is active: inspected `main` commit `493a410270b83f94d7504b2eb979deb777e8ced7`, dated 2026-09-03.

Known limitations that must appear in `docs/tradingview-compatibility.md`:

- Upstream documents an approximate margin-liquidation formula, identity currency conversion, unenforced OCA sibling cancellation/reduction, commission-rounding differences, and per-trade drawdown/run-up differences.
- The public [issue tracker](https://github.com/LuxAlgo/PineTS/issues) contains current parser, numeric-semantics and `request.security` gaps.
- PineTS compiles generated JavaScript with `new Function` ([source](https://github.com/LuxAlgo/PineTS/blob/main/src/transpiler/index.ts)). Pasted user code therefore must never execute in the API process or in a process that can see credentials.
- The package declares `AGPL-3.0-only`; upstream also offers a commercial license. Before publishing the product license, obtain a license review and ensure distribution/network-use obligations are satisfied. Do not label the combined product MIT or Apache by assumption.

### Resin

Why it remains a serious challenger:

- It is TypeScript, accepts native v5/v6, returns plot/drawing data, has no production dependencies, and is Apache-2.0 ([README](https://github.com/nullarch/resin), [package metadata](https://github.com/nullarch/resin/blob/main/package.json)).
- Its documented corpus and differential tests are promising for language and indicator semantics.
- The local strategy test file is extensive and fast.

Why it is not the default yet:

- It is young: inspected `main` commit `4d0d8e72533cbeb65337bfba770a949d7c8186d7`, dated 2026-08-12, package version 0.2.2.
- Its own README says market fills follow the documented next-bar-open rule but have not been confirmed side-by-side against TradingView, and intrabar paths are necessarily modeled.
- It requires Node.js 22.18 or newer; the current workstation has Node.js 22.17.1.
- It also compiles generated JavaScript with `new Function` ([source](https://github.com/nullarch/resin/blob/main/src/runtime/engine.ts)), so it needs the same isolation boundary as PineTS.

### PyneCore

[PyneCore](https://github.com/PyneSys/pynecore) is active, Apache-2.0, and its runtime has substantial strategy, broker and live-mode functionality. Inspected `main` commit `46d392cc231f944c7f63264f37960edfcb77f6c0`, dated 2026-09-05.

It does not satisfy the core product contract: the upstream [README](https://github.com/PyneSys/pynecore#working-with-pine-script-files) states that running or compiling a `.pine` file requires a PyneSys API key. The open runtime executes PyneCore-flavoured Python after conversion; the required direct Pine compiler is not a fully local open-source path. It may be reconsidered only if an open, local compiler becomes available.

### Adjacent projects

- [Backtest Kit](https://github.com/tripolskypetr/backtest-kit) is active and MIT (`main` commit `78690c169c8d81d738aafc9dd6929623b718bded`, 2026-09-05). It is a broad execution framework, not an independent Pine compiler; its Pine package wraps PineTS. Reuse ideas, not the framework, until the MVP proves its smaller vertical slice.
- [OpenPineScript](https://github.com/be-thomas/OpenPineScript) is architecturally relevant but its current README marks v3-v5 as planned. It cannot run the target v5/v6 strategies today.
- [PineForge](https://github.com/pineforge-4pass/pineforge-engine) publishes impressive engine validation, but its [code generator](https://github.com/pineforge-4pass/pineforge-codegen-oss) uses a noncommercial source-available license for the Pine-to-C++ path. That conflicts with the goal of a fully open-source reusable product.
- [pine-transpiler](https://github.com/Opus-Aether-AI/pine-transpiler) and [Pine-A-Script](https://github.com/MeridianAlgo/Pine-A-Script) are indicator-oriented; `strategy.*` execution is absent or out of scope.

## Local verification

Environment:

- Node.js `v22.17.1`
- npm `10.9.2`
- Git `2.51.0.windows.1`
- Docker CLI: not installed, so no Docker build was attempted

Checks performed from shallow, temporary upstream clones:

| Candidate | Check | Result |
| --- | --- | --- |
| PineTS | `tests/namespaces/strategy` | **PASS** — 10 files, 42 tests |
| Resin | `tests/unit/strategy.test.ts` | **PASS** — 1 file, 797 tests |
| PineTS | `npm audit --omit=dev` | **PASS** — 0 known production vulnerabilities; full development tree reported 12 findings (2 low, 4 moderate, 6 high) |
| Resin | `npm audit --omit=dev` | **PASS** — 0 known production vulnerabilities; full development tree reported 2 findings (1 moderate, 1 high) |

The Resin test passed on Node 22.17.1, but npm correctly emitted an engine-version warning. That run is useful evidence, not proof that the unsupported Node version is safe for production.

Not verified:

- trade-for-trade output against TradingView exports;
- arbitrary real-world scripts supplied by the product owner;
- execution time and memory limits under hostile or pathological Pine source;
- Docker build or Linux process isolation;
- Binance data ingestion;
- paper or live trading.

## Required runtime boundary

The MVP may remain a modular monolith, but Pine execution must cross a narrow subprocess boundary:

1. The API validates a JSON request containing Pine source, normalized OHLCV, declared inputs and resource limits.
2. A disposable, unprivileged worker receives only that request. It receives an empty/sanitized environment, no exchange credentials, no writable project filesystem and no network access.
3. The worker compiles and runs Pine under hard limits for source size, bars, wall time, memory, plots and generated orders.
4. The worker returns a versioned JSON result containing diagnostics, strategy intents, plots and raw runtime trades.
5. The product-owned backtest/execution layer remains responsible for normalized orders, fills, fees, slippage, portfolio accounting and compatibility reporting.

For the backtest-only MVP, no exchange credentials are needed anywhere. Future exchange signing must stay in a separate backend component and must never share a process or environment with Pine execution.

## Qualification gate before architecture lock

PineTS is the default candidate, but adoption is conditional on one small, reproducible spike:

1. Pin exact PineTS and Resin revisions; do not use floating `latest` versions.
2. Run the seven required reference strategies (Buy & Hold, SMA, EMA, RSI, SL/TP, long+short, pyramiding) on one immutable OHLCV fixture.
3. Compare compilation diagnostics, entries/exits, quantities, prices, fees, net PnL and max drawdown.
4. Add TradingView exports for the same scripts and fixture when legally and practically available; classify every difference as supported, partial or unsupported.
5. Verify timeout, memory-limit and malformed-source failures are loud and leave no worker behind.
6. Select PineTS if it passes the gate. Select Resin only if it materially outperforms PineTS on correctness and operational safety; otherwise keep Resin as a tracked fallback.

No runtime dependency should be added to the product until this gate is encoded as automated tests. This preserves the central rule: execution correctness is more important than UI speed or feature count.
