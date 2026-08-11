# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS dependencies
WORKDIR /opt/t4
COPY . /opt/t4
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts

FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7
COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun
USER root
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends --allow-downgrades \
       openssh-client=1:9.2p1-2+deb12u6 \
       openssh-server=1:9.2p1-2+deb12u6 \
       openssh-sftp-server=1:9.2p1-2+deb12u6 \
       tini=0.19.0-1 \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd --uid 10001 --user-group --create-home --home-dir /home/t4ssh --shell /bin/sh t4ssh \
    && passwd -d t4ssh \
    && mkdir -p /run/sshd
WORKDIR /opt/t4
COPY --from=dependencies /opt/t4 /opt/t4
COPY cluster/images/ssh-gateway/sshd_config /etc/ssh/sshd_config_t4
COPY cluster/images/ssh-gateway/entrypoint.sh /usr/local/bin/t4-ssh-gateway-entrypoint
RUN chmod 0755 /usr/local/bin/t4-ssh-gateway-entrypoint /opt/t4/packages/ssh-gateway/src/bin.ts \
    && chown -R root:root /opt/t4 /etc/ssh/sshd_config_t4 /usr/local/bin/t4-ssh-gateway-entrypoint
ENV NODE_ENV=production \
    HOME=/home/t4ssh
ARG SOURCE_REPOSITORY=https://github.com/wolfiesch/omperator
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 OpenSSH provider gateway"
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t4-ssh-gateway-entrypoint"]
