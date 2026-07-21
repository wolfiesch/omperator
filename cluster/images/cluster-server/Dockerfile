# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS dependencies
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
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/t4
COPY --from=dependencies /opt/t4 /opt/t4
ENV NODE_ENV=production \
    HOME=/tmp \
    T4_CLUSTER_SERVER_PORT=8080 \
    T4_CLUSTER_ADMIN_PORT=9090
ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 stateless cluster server"
USER 10001:10001
EXPOSE 8080 9090
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bun", "packages/cluster-server/src/main.ts"]
