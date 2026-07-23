# syntax=docker/dockerfile:1.7

FROM docker.io/library/rust:1.86-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944 AS omp-build
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/omp
RUN git init \
    && git remote add origin https://github.com/wolfiesch/oh-my-pi.git \
    && git fetch --depth=1 origin "refs/tags/t4code-17.0.5-appserver-12" \
    && test "$(git rev-parse FETCH_HEAD)" = "2eef185481d499c6e04323b71eda550a54bd4550" \
    && git checkout --detach "2eef185481d499c6e04323b71eda550a54bd4550"
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun --cwd=packages/natives run build \
    && bun --cwd=packages/coding-agent run gen:tool-views \
    && grep -R -F -q 't4-omp-authority/1' packages/coding-agent \
    && rm -rf .git

FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS t4-build
WORKDIR /opt/t4
COPY . /opt/t4
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts

FROM docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
USER root
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates chromium fluxbox git openssh-client python3 ripgrep tini xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/t4/bin /opt/omp /workspace /run/t4 \
    && chown -R 10001:10001 /workspace /run/t4
COPY --from=omp-build /opt/omp /opt/omp
COPY --from=t4-build /opt/t4 /opt/t4
COPY cluster/images/session-runtime/session-entrypoint.sh /opt/t4/bin/session-entrypoint
RUN printf '%s\n' \
      '#!/usr/bin/env bash' \
      'set -euo pipefail' \
      'export PI_ROOT=/opt/omp' \
      'exec /usr/local/bin/bun /opt/omp/packages/coding-agent/src/cli.ts "$@"' \
      > /opt/t4/bin/omp \
    && chmod 0755 /opt/t4/bin/omp /opt/t4/bin/session-entrypoint \
    && chown -R 10001:10001 /opt/t4 /opt/omp
ENV PI_ROOT=/opt/omp \
    T4_OMP_EXECUTABLE=/opt/t4/bin/omp \
    T4_WORKSPACE_ROOT=/workspace \
    T4_HOST_PORT=8787 \
    DISPLAY=:99 \
    HOME=/workspace/.t4/runtime \
    XDG_RUNTIME_DIR=/run/t4
ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 OMP session runtime" \
      io.t4.omp.version="17.0.5" \
      io.t4.omp.tag="t4code-17.0.5-appserver-12" \
      io.t4.omp.commit="2eef185481d499c6e04323b71eda550a54bd4550" \
      io.t4.omp.authority="t4-omp-authority/1" \
      io.t4.gui.display="Xvfb"
USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/t4/bin/session-entrypoint"]
