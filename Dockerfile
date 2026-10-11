# syntax=docker/dockerfile:1.7
# Pine Strategy Runner: site, backtests and Paper engine in one container.
# Users run the published image (compose.yaml). To build it yourself:
#   docker compose -f compose.yaml -f compose.build.yaml up -d --build
# The Nautilus wheel (pinned source + Hyperliquid fast-book patch) comes either from
# the published wheel image (NAUTILUS_WHEEL=prebuilt) or is compiled here (source,
# about 20-60 minutes and several GB of memory).

ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG NAUTILUS_WHEEL=source
ARG NAUTILUS_WHEEL_IMAGE=ghcr.io/solovit12/pine-strategy-runner-nautilus:2.0.0rc6.dev20260929-hlfast5.1

# ---------------------------------------------------------------------------
# 1. Nautilus Trader wheel, same recipe as apps/nautilus-paper/patches/hyperliquid-fast5
FROM ${PYTHON_IMAGE} AS nautilus-source
ARG TARGETARCH
ARG RUST_VERSION=1.98.1
ARG MATURIN_VERSION=1.15.0
ARG CARGO_BUILD_JOBS=4
# The upstream profile links with fat LTO, which needs more than 25 GB of memory on
# arm64. Thin LTO builds the same source within a few GB; pass fat to match exactly.
ARG NAUTILUS_LTO=thin
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential clang lld curl ca-certificates patch pkg-config \
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN set -eu; \
    case "$TARGETARCH" in amd64) triple=x86_64-unknown-linux-gnu ;; arm64) triple=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac; \
    base="https://static.rust-lang.org/rustup/dist/$triple"; \
    curl -fsSLo /tmp/rustup-init "$base/rustup-init"; \
    echo "$(curl -fsSL "$base/rustup-init.sha256" | cut -d' ' -f1)  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION"; \
    rm /tmp/rustup-init
WORKDIR /build
COPY apps/nautilus-paper/patches/hyperliquid-fast5 /recipe
RUN python /recipe/prepare_source.py --work-dir /build/fast \
 && python -m venv /build/venv \
 && /build/venv/bin/pip install --no-cache-dir "maturin==$MATURIN_VERSION" patchelf
WORKDIR /build/fast/source/python
# The target directory is a build cache, so an interrupted build resumes where it stopped.
RUN --mount=type=cache,id=psr-nautilus-target-${TARGETARCH},target=/build/target \
    --mount=type=cache,id=psr-cargo-registry,target=/opt/cargo/registry \
    CARGO_TARGET_DIR=/build/target CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS GIT_CEILING_DIRECTORIES=/build/fast \
    CARGO_PROFILE_RELEASE_LTO=$NAUTILUS_LTO \
    PYO3_PYTHON=/build/venv/bin/python PATH=/build/venv/bin:$PATH \
    maturin build --release --locked --compatibility linux --interpreter /build/venv/bin/python --out /wheels

# The wheel alone, published by CI as the wheel image.
FROM scratch AS nautilus-wheel-image
COPY --from=nautilus-source /wheels /wheels

FROM ${NAUTILUS_WHEEL_IMAGE} AS nautilus-prebuilt
FROM nautilus-${NAUTILUS_WHEEL} AS nautilus-wheel

# ---------------------------------------------------------------------------
# 2. Site and API
FROM ${NODE_IMAGE} AS app
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY scripts/ensure-pinets-build.mjs ./scripts/ensure-pinets-build.mjs
COPY vendor/pinets ./vendor/pinets
RUN npm ci --no-audit --no-fund
COPY . .
# The runtime user only reads the app; source files may arrive owner-only (umask 077).
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && chmod -R a+rX,go-w /app

# ---------------------------------------------------------------------------
# 3. Runtime: Python with the wheel, Node, the built app
FROM ${PYTHON_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin psr \
 && mkdir -p /data && chown psr:psr /data
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=nautilus-wheel /wheels /tmp/wheels
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels
WORKDIR /app
COPY --from=app /app /app
ENV HOST=0.0.0.0 PORT=8787 PSR_ROLE=all PAPER_ENABLED=1 \
    PSR_NAUTILUS_PYTHON=/opt/venv/bin/python \
    STRATEGY_CATALOG_DIR=/data/strategy-catalog \
    PAPER_EXPERIMENTS_DIR=/data/paper-experiments \
    PAPER_RUNS_DIR=/data/paper-runs
# The engine refuses to start without the exact qualified build.
RUN /opt/venv/bin/python apps/nautilus-paper/runtime.py --check-fast-book
USER psr
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/apps/api/src/server.js"]
