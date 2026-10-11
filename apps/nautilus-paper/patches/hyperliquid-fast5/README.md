# Isolated Hyperliquid fast5 candidate

This patch lets the pinned native Hyperliquid adapter send `fast: true` for an
explicit order-book delta subscription. It keeps the same native data path and
snapshot parser. Missing `fast` stays absent on the wire; `false` stays false.
Quote/BBO subscriptions, Lighter, execution, and the current installation are
unchanged. The app decides whether to opt in. There is no deeper-book fallback.

The patch is against official Nautilus commit
`f3c5702f5c82872b9981c7859d47b667d4bcb999`, with candidate package version
`2.0.0rc6.dev20260929+hlfast5.1`. `manifest.json` pins the source archive, patch,
and each changed file. It retains the original wheel's features and the pinned
source's existing execution fixes; the old rc5 HYPE/USDC proposal is not applied.

The native module exports the boolean
`nautilus_trader.adapters.hyperliquid.HYPERLIQUID_FAST_BOOK_SUPPORTED`.
The Python facade re-exports it and its generated stub documents it. The app
requires this capability and the exact candidate version before using fast5.

## Subscription behavior

- Only the adapter's `subscribe_book_deltas` command reads the optional `fast`
  parameter. It rejects non-boolean values. The app uses this delta path.
- The new Rust `subscribe_book_with_fast_options` method preserves the existing
  API through delegation from `subscribe_book_with_options`.
- As in the upstream adapter, the first subscriber to a shared instrument book
  determines its options. Conflicts are warned about. The options are retained
  for transparent reconnect, targeted resubscribe, and final unsubscribe.
- The production parser is unchanged. Each complete `WsBookData` message becomes
  CLEAR plus snapshot deltas, ending in `F_LAST`, so old prices are removed.

## Rebuild without changing an installed environment

Use a **new directory** inside the project's `.local` directory for each build.
`prepare_source.py` refuses an existing source or extraction directory. It only
downloads the pinned public source, applies this patch, and checks hashes. It
does not install tools or a wheel, start a service, or connect to an exchange.

The build recipe uses Python 3.12, Rust 1.98.1, maturin 1.15.0, Apple arm64,
deployment target macOS 11.0, at most two compiler jobs, and process niceness 10.
Use an isolated `RUSTUP_HOME`, `CARGO_HOME`, target directory, and Python venv.
Do not point any of them at the current paper environment.

Example preparation from the repository root (set `FAST_ROOT` to a new absolute
path and `BUILD_PYTHON` to an existing Python 3.12 interpreter):

```sh
"$BUILD_PYTHON" apps/nautilus-paper/patches/hyperliquid-fast5/prepare_source.py \
  --work-dir "$FAST_ROOT"
"$BUILD_PYTHON" -m venv "$FAST_ROOT/.venv"
"$FAST_ROOT/.venv/bin/python" -m pip install --no-cache-dir maturin==1.15.0
```

For the original candidate, the isolated rustup installer came from
`https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init` and was
verified against the official checksum before execution. Its SHA-256 was
`ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a`.
Use `--no-modify-path --profile minimal --default-toolchain 1.98.1` with the
isolated `CARGO_HOME` and `RUSTUP_HOME`. No global installation or shell profile
change is needed.

Run the build from `$FAST_ROOT/source/python` with these **process-local**
environment variables:

```sh
env CARGO_HOME="$FAST_ROOT/cargo-home" \
  RUSTUP_HOME="$FAST_ROOT/rustup-home" \
  CARGO_TARGET_DIR="$FAST_ROOT/build" CARGO_BUILD_JOBS=2 \
  GIT_CEILING_DIRECTORIES="$FAST_ROOT" \
  MACOSX_DEPLOYMENT_TARGET=11.0 \
  PYO3_PYTHON="$FAST_ROOT/.venv/bin/python" \
  SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  PATH="$FAST_ROOT/cargo-home/bin:$FAST_ROOT/.venv/bin:$PATH" \
  /usr/bin/nice -n 10 "$FAST_ROOT/.venv/bin/maturin" build --release --locked \
    --interpreter "$FAST_ROOT/.venv/bin/python" --out "$FAST_ROOT/wheels"
```

The initial host default selected the installed macOS 27 SDK, whose `arm64e.x1`
library descriptions were incompatible with the host linker. Selecting the
already installed 26.5 SDK for this process fixed the probe link. No system SDK
or global setting was changed. Other hosts must select their own compatible,
already installed SDK instead of assuming this absolute path exists.

`GIT_CEILING_DIRECTORIES` prevents the archive build from discovering the parent
Pine repository and embedding its unrelated commit in the native log header.
The archive has no Git checkout, so this header omits the commit. The exact
upstream revision and patched file identities are recorded in `manifest.json`.
Do not initialize a fake Git history merely to populate this log field.

Install the resulting wheel **only into this candidate venv**. Record its SHA-256
and verify the exact package version and native capability before public probes.
Building or testing the candidate does not authorize changing the running paper
environment or starting a strategy.

## Focused native checks

With the same isolated toolchain environment, run these from the source root,
sequentially (do not run another compiler concurrently):

```sh
cargo test --locked --profile nextest -p nautilus-hyperliquid --lib parse_book_fast
cargo test --locked --profile nextest -p nautilus-hyperliquid --lib l2_book_fast
cargo test --locked --profile nextest -p nautilus-hyperliquid --lib fast_option_survives
cargo test --locked --profile nextest -p nautilus-hyperliquid --lib fast_book_snapshots
cargo test --locked --profile nextest -p nautilus-hyperliquid --test integration \
  book_precision_options_survive_reconnection
cargo test --locked --profile nextest -p nautilus-hyperliquid --test integration \
  resubscribe_book_echoes_original_options
```

The four unit filters cover strict parameter parsing, absent/false/true JSON,
shared-stream option retention, and actual native 5-level to 2-level snapshot
replacement. The localhost WebSocket integration tests check absent/false/true
options after a real transport reconnect and targeted resubscription. They do
not place orders or use exchange credentials. Test/build results belong in the
qualification report; the existence of this recipe is not a passing result.
The pinned source's `nextest` profile retains test assertions but skips debug
symbols and release LTO. Test dependencies may still need a separate compile:
the release wheel uses a different feature set and abort-on-panic behavior.
