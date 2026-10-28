# syntax=docker/dockerfile:1.7

# Build context: checksum-verified upstream minio/mc source at the fixed commit.
ARG GO_BUILD_IMAGE
ARG RUNTIME_IMAGE
FROM ${GO_BUILD_IMAGE} AS build

ARG GO_BUILD_IMAGE
ARG RUNTIME_IMAGE
ARG TARGETARCH
ENV GOMAXPROCS=2 \
    GOMEMLIMIT=1536MiB

RUN go_pin="${GO_BUILD_IMAGE#*@sha256:}" \
 && runtime_pin="${RUNTIME_IMAGE#*@sha256:}" \
 && test "${go_pin}" != "${GO_BUILD_IMAGE}" \
 && test "${runtime_pin}" != "${RUNTIME_IMAGE}" \
 && test "${#go_pin}" -eq 64 \
 && test "${#runtime_pin}" -eq 64 \
 && case "${go_pin}${runtime_pin}" in *[!0-9a-f]*) exit 64 ;; esac \
 && test "$(go env GOVERSION)" = "go1.24.8"

WORKDIR /src
COPY . /src

# The extracted release archive has no .git directory, so embed the official
# tag identity that upstream's gen-ldflags.go would otherwise derive from git.
RUN test "$(sed -n 's/^toolchain go\(.*\)$/\1/p' go.mod)" = "1.23.10" \
 && GO111MODULE=on CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -p 2 \
      -tags kqueue -trimpath \
      -ldflags='-s -w -X github.com/minio/mc/cmd.Version=2025-08-13T08:35:41Z -X github.com/minio/mc/cmd.CopyrightYear=2025 -X github.com/minio/mc/cmd.ReleaseTag=RELEASE.2025-08-13T08-35-41Z -X github.com/minio/mc/cmd.CommitID=7394ce0dd2a80935aded936b09fa12cbb3cb8096 -X github.com/minio/mc/cmd.ShortCommitID=7394ce0dd2a8' \
      -o /out/mc .

FROM ${RUNTIME_IMAGE} AS runtime

LABEL org.opencontainers.image.title="MinIO Client for AVA Onyx bootstrap QA" \
      org.opencontainers.image.description="Ephemeral root init client built from checksum-verified MinIO Community mc source" \
      org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.url="https://github.com/minio/mc/releases/tag/RELEASE.2025-08-13T08-35-41Z" \
      org.opencontainers.image.version="RELEASE.2025-08-13T08-35-41Z" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="MinIO, Inc."

COPY --from=build --chown=0:0 --chmod=0555 /out/mc /usr/bin/mc
COPY --from=build --chown=0:0 --chmod=0444 /src/LICENSE /licenses/LICENSE

# The existing one-shot bootstrap overrides ENTRYPOINT with /bin/sh and uses
# these BusyBox utilities. Refuse a runtime base that lacks that contract.
RUN for tool in sh cp cmp mktemp; do command -v "${tool}" >/dev/null || exit 65; done

ENV MC_CONFIG_DIR=/tmp/mc \
    MC_NO_COLOR=1

USER 0:0
ENTRYPOINT ["/usr/bin/mc"]
CMD ["--help"]
