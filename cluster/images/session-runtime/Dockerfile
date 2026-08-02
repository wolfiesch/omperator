# syntax=docker/dockerfile:1.7

FROM docker.io/library/rust:1.86-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944 AS omp-build
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git libclang-dev pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun
COPY provenance/omp-runtime-v1.json /opt/provenance/omp-runtime-v1.json
WORKDIR /opt/omp
RUN omp_repository="$(bun -p 'require("/opt/provenance/omp-runtime-v1.json").source.repository')" \
    && omp_commit="$(bun -p 'require("/opt/provenance/omp-runtime-v1.json").source.commit')" \
    && test "${omp_repository}" = "https://github.com/wolfiesch/oh-my-pi" \
    && printf '%s' "${omp_commit}" | grep -Eq '^[0-9a-f]{40}$' \
    && git init \
    && git remote add origin "${omp_repository}.git" \
    && git fetch --depth=1 origin "${omp_commit}" \
    && test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "${omp_commit}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${omp_commit}"
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun --cwd=packages/natives run build \
    && bun --cwd=packages/coding-agent run gen:tool-views
RUN test "$(bun --cwd=packages/coding-agent -e 'import { OMP_AUTHORITY_BRIDGE_PROTOCOL } from "@oh-my-pi/appserver"; process.stdout.write(OMP_AUTHORITY_BRIDGE_PROTOCOL)')" = 't4-omp-authority/1' \
    && test "$(bun --cwd=packages/coding-agent -e 'import { OMP_AUTHORITY_BRIDGE_METHODS } from "@oh-my-pi/appserver"; process.stdout.write(JSON.stringify(OMP_AUTHORITY_BRIDGE_METHODS))')" = "$(bun -p 'JSON.stringify(require("/opt/provenance/omp-runtime-v1.json").bridge.methods)')" \
    && rm -rf .git

FROM --platform=$BUILDPLATFORM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS cmux-node

FROM --platform=$BUILDPLATFORM docker.io/library/rust:1.86-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944 AS cmux-build
ARG BUILDARCH
ARG TARGETARCH
ENV SOURCE_DATE_EPOCH=0 \
    CARGO_INCREMENTAL=0
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && case "${TARGETARCH}" in \
      amd64) cross_linker_package=gcc-x86-64-linux-gnu; cross_libc_package=libc6-dev-amd64-cross ;; \
      arm64) cross_linker_package=gcc-aarch64-linux-gnu; cross_libc_package=libc6-dev-arm64-cross ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}; expected amd64 or arm64" >&2; exit 64 ;; \
    esac \
    && apt-get install -y --no-install-recommends ca-certificates curl git libclang-dev xz-utils "${cross_linker_package}" "${cross_libc_package}" \
    && rm -rf /var/lib/apt/lists/*
COPY --from=cmux-node /usr/local/bin/node /usr/local/bin/node
COPY scripts/build-pinned-cmux.mjs /opt/scripts/build-pinned-cmux.mjs
COPY provenance/cmux-runtime-v1.json /opt/provenance/cmux-runtime-v1.json
RUN zig_version="$(node -p 'require("/opt/provenance/cmux-runtime-v1.json").build.zigToolchain')" \
    && case "${BUILDARCH}" in \
      amd64) zig_arch=x86_64; zig_sha=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239 ;; \
      arm64) zig_arch=aarch64; zig_sha=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f ;; \
      *) echo "unsupported BUILDARCH=${BUILDARCH}; expected amd64 or arm64" >&2; exit 64 ;; \
    esac \
    && case "${TARGETARCH}" in \
      amd64) rust_target=x86_64-unknown-linux-gnu ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}; expected amd64 or arm64" >&2; exit 64 ;; \
    esac \
    && curl --fail --location --proto '=https' --tlsv1.2 \
       --output /tmp/zig.tar.xz "https://ziglang.org/download/${zig_version}/zig-${zig_arch}-linux-${zig_version}.tar.xz" \
    && echo "${zig_sha}  /tmp/zig.tar.xz" | sha256sum --check --strict \
    && mkdir /opt/zig \
    && tar --extract --xz --file /tmp/zig.tar.xz --strip-components=1 --directory /opt/zig \
    && test "$(/opt/zig/zig version)" = "${zig_version}" \
    && printf '%s' "${rust_target}" > /tmp/rust-target \
    && rm /tmp/zig.tar.xz
RUN cmux_repository="$(node -p 'require("/opt/provenance/cmux-runtime-v1.json").source.repository')" \
    && cmux_commit="$(node -p 'require("/opt/provenance/cmux-runtime-v1.json").source.commit')" \
    && mkdir -p /src/cmux \
    && git -C /src/cmux init \
    && git -C /src/cmux remote add origin "${cmux_repository}" \
    && git -C /src/cmux fetch --depth=1 origin "${cmux_commit}" \
    && test "$(git -C /src/cmux rev-parse FETCH_HEAD)" = "${cmux_commit}" \
    && git -C /src/cmux checkout --detach FETCH_HEAD \
    && PATH="/opt/zig:${PATH}" node /opt/scripts/build-pinned-cmux.mjs \
       --source /src/cmux --out /out --target "$(cat /tmp/rust-target)" \
    && mv "/out/cmux-tui-$(cat /tmp/rust-target)" /out/cmux-tui \
    && mv "/out/cmux-tui-$(cat /tmp/rust-target).manifest.json" /out/cmux-tui.manifest.json \
    && rm -rf /src/cmux

FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS t4-build
COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/t4
COPY . /opt/t4
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts
RUN mkdir -p /out \
    && bun build packages/cluster-server/src/terminal-attach-client.ts --target=bun --outfile=/out/terminal-attach-client.js \
    && bun build packages/cluster-server/src/session-runtime-supervisor.ts --target=bun --outfile=/out/session-runtime-supervisor.js \
    && bun build packages/cluster-server/src/session-credential-broker.ts --target=bun --outfile=/out/session-credential-broker.js \
    && bun build packages/cluster-server/src/session-runtime-readiness.ts --target=bun --outfile=/out/session-runtime-readiness.js

FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7
USER root
COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates chromium fluxbox git openssh-client python3 ripgrep tini util-linux xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 20001 t4-session \
    && useradd --uid 10001 --gid 20001 --no-create-home --shell /usr/sbin/nologin t4-authority \
    && useradd --uid 10002 --gid 20001 --no-create-home --shell /bin/bash t4-shell \
    && useradd --uid 10003 --gid 20001 --no-create-home --shell /usr/sbin/nologin t4-credential \
    && mkdir -p /opt/t4/bin /opt/t4/libexec /opt/omp /workspace /run/t4 /usr/local/lib/t4 /usr/share/t4/provenance /usr/share/licenses/cmux \
    && chmod 0755 /usr/share/t4 /usr/share/t4/provenance /usr/share/licenses /usr/share/licenses/cmux /usr/local/lib/t4 \
    && chown -R 10001:20001 /workspace /run/t4 \
    && chmod 0711 /run/t4
COPY --from=cmux-build --chmod=0755 /out/cmux-tui /usr/local/bin/cmux-tui
COPY --from=cmux-build --chmod=0644 /out/cmux-tui.manifest.json /usr/share/t4/provenance/cmux-tui.manifest.json
COPY --chmod=0644 provenance/cmux-runtime-v1.json /usr/share/t4/provenance/cmux-runtime-v1.json
COPY --chmod=0644 provenance/omp-runtime-v1.json /usr/share/t4/provenance/omp-runtime-v1.json
COPY --chmod=0644 licenses/CMUX-TUI-MIT-NOTICE.txt /usr/share/licenses/cmux/CMUX-TUI-MIT-NOTICE.txt
COPY --chmod=0644 licenses/CMUX-UPSTREAM-LICENSE.txt /usr/share/licenses/cmux/CMUX-UPSTREAM-LICENSE.txt
COPY --from=omp-build /opt/omp /opt/omp
COPY --from=t4-build /opt/t4 /opt/t4
COPY --from=t4-build --chmod=0555 /out/terminal-attach-client.js /usr/local/lib/t4/terminal-attach-client.js
COPY --from=t4-build --chmod=0555 /out/session-runtime-supervisor.js /usr/local/lib/t4/session-runtime-supervisor.js
COPY --from=t4-build --chmod=0555 /out/session-credential-broker.js /usr/local/lib/t4/session-credential-broker.js
COPY --from=t4-build --chmod=0555 /out/session-runtime-readiness.js /usr/local/lib/t4/session-runtime-readiness.js
COPY cluster/images/session-runtime/session-entrypoint.sh /opt/t4/bin/session-entrypoint
COPY cluster/images/session-runtime/session-shell-entrypoint.sh /usr/local/bin/t4-session-shell
RUN printf '%s\n' \
      '#!/usr/bin/env bash' \
      'set -euo pipefail' \
      'export PI_ROOT=/opt/omp' \
      'exec /usr/local/bin/bun /opt/omp/packages/coding-agent/src/cli.ts "$@"' \
      > /opt/t4/libexec/omp-authority \
    && printf '%s\n' \
      '#!/usr/bin/env bash' \
      'set -euo pipefail' \
      'exec /usr/local/bin/bun /usr/local/lib/t4/terminal-attach-client.js "$@"' \
      > /usr/local/bin/omp \
    && chmod 0700 /opt/t4/libexec/omp-authority /opt/t4/bin/session-entrypoint \
    && chmod 0555 /usr/local/bin/omp /usr/local/bin/t4-session-shell \
    && chown -R 10001:20001 /opt/t4 /opt/omp \
    && chmod -R go-rwx /opt/t4 /opt/omp \
    && chown root:root /usr/local/bin/omp /usr/local/bin/t4-session-shell /usr/local/lib/t4/terminal-attach-client.js /usr/local/lib/t4/session-runtime-supervisor.js /usr/local/lib/t4/session-credential-broker.js /usr/local/lib/t4/session-runtime-readiness.js
ENV T4_WORKSPACE_ROOT=/workspace \
    T4_HOST_PORT=8787 \
    T4_OMP_BUILD=b86f6116e6223ebb2d747748dc1dc14ddcb35428 \
    DISPLAY=:99 \
    HOME=/run/t4 \
    XDG_RUNTIME_DIR=/run/t4
ARG SOURCE_REPOSITORY=https://github.com/wolfiesch/omperator
ARG SOURCE_COMMIT
ARG IMAGE_VERSION=portable-agent-platform-v1
ARG TARGETARCH
RUN printf '%s' "${SOURCE_COMMIT}" | grep -Eq '^[0-9a-f]{40}$'
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.title="T4 OMP session runtime" \
      io.t4.image.architecture="${TARGETARCH}" \
      io.t4.cmux.provenance="/usr/share/t4/provenance/cmux-runtime-v1.json" \
      io.t4.cmux.binary-manifest="/usr/share/t4/provenance/cmux-tui.manifest.json" \
      io.t4.cmux.license="MIT" \
      io.t4.omp.version="17.1.2" \
      io.t4.omp.revision="b86f6116e6223ebb2d747748dc1dc14ddcb35428" \
      io.t4.omp.contract-revision="d16c6168c86f40fc44f25118c2fd06fe160fcb93" \
      io.t4.omp.provenance="/usr/share/t4/provenance/omp-runtime-v1.json" \
      io.t4.omp.authority="t4-omp-authority/1" \
      io.t4.gui.display="Xvfb"
USER 10001:20001
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/t4/bin/session-entrypoint"]
