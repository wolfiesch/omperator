# syntax=docker/dockerfile:1.7
FROM docker.io/library/golang:1.24.5-bookworm@sha256:ef8c5c733079ac219c77edab604c425d748c740d8699530ea6aced9de79aea40 AS build
WORKDIR /src/packages/cluster-operator
COPY packages/cluster-operator/go.mod ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY packages/cluster-operator/ ./
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w -buildid=' -o /out/t4-cluster-operator ./cmd/manager

FROM gcr.io/distroless/static-debian12:nonroot@sha256:7a2bd171a18bdd39a4729600d0dca5f16e779d41156a6908b4f8a9a289e76d92
ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 cluster operator"
COPY --from=build --chown=65532:65532 /out/t4-cluster-operator /usr/local/bin/t4-cluster-operator
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/t4-cluster-operator"]
