# syntax=docker/dockerfile:1.7

# Both images are supplied by the caller as immutable registry references.
# Example form: registry.example/image@sha256:<64 lowercase hex characters>
ARG GO_BUILD_IMAGE
ARG RUNTIME_IMAGE
FROM ${GO_BUILD_IMAGE} AS build

ARG GO_BUILD_IMAGE
ARG RUNTIME_IMAGE
ARG TARGETARCH
ENV GOMAXPROCS=2 \
    GOMEMLIMIT=1536MiB

# Fail before compiling when either caller-controlled base is tag-only. The
# registry may resolve FROM first, so policy must also reject unpinned args
# before invoking docker build (documented in README.md).
RUN go_pin="${GO_BUILD_IMAGE#*@sha256:}" \
 && runtime_pin="${RUNTIME_IMAGE#*@sha256:}" \
 && test "${go_pin}" != "${GO_BUILD_IMAGE}" \
 && test "${runtime_pin}" != "${RUNTIME_IMAGE}" \
 && test "${#go_pin}" -eq 64 \
 && test "${#runtime_pin}" -eq 64 \
 && case "${go_pin}${runtime_pin}" in *[!0-9a-f]*) exit 64 ;; esac \
 && test "$(go env GOVERSION)" = "go1.24.8"

WORKDIR /src
# The build context is the separately fetched and checksum-verified upstream
# source tree for commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a.
COPY . /src

# The release generator depends on .git, which is not present in an extracted
# source archive. Embed the exact official release identity explicitly.
RUN test "$(sed -n 's/^toolchain go\(.*\)$/\1/p' go.mod)" = "1.24.8" \
 && CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -p 2 \
      -tags kqueue -trimpath \
      -ldflags='-s -w -X github.com/minio/minio/cmd.Version=2025-10-15T17:29:55Z -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z -X github.com/minio/minio/cmd.CommitID=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a -X github.com/minio/minio/cmd.ShortCommitID=9e49d5e7a648' \
      -o /out/minio .

# A fixed, dependency-free health probe avoids claiming that mc, curl, wget,
# or a shell exists in the runtime image.
RUN <<'EOF'
cat >/tmp/minio-healthcheck.go <<'GO'
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	client := http.Client{Timeout: 4 * time.Second}
	response, err := client.Get("http://127.0.0.1:9000/minio/health/live")
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		os.Exit(1)
	}
}
GO
CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -p 2 -trimpath -ldflags='-s -w' -o /out/minio-healthcheck /tmp/minio-healthcheck.go
mkdir -p /out/data /out/home
EOF

FROM ${RUNTIME_IMAGE} AS runtime

LABEL org.opencontainers.image.title="MinIO Community for AVA Onyx QA" \
      org.opencontainers.image.description="Non-root QA build of MinIO Community from checksum-verified upstream source" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.url="https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.documentation="https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/docs" \
      org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="MinIO, Inc."

COPY --from=build --chown=0:0 --chmod=0555 /out/minio /usr/local/bin/minio
COPY --from=build --chown=0:0 --chmod=0555 /out/minio-healthcheck /usr/local/bin/minio-healthcheck
COPY --from=build --chown=0:0 --chmod=0444 /src/LICENSE /licenses/LICENSE
COPY --from=build --chown=1001:1001 /out/data/ /data/
COPY --from=build --chown=1001:1001 /out/home/ /home/minio/

ENV HOME=/home/minio \
    MINIO_CONFIG_ENV_FILE=/home/minio/config.env

USER 1001:1001
WORKDIR /data
EXPOSE 9000 9001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/usr/local/bin/minio-healthcheck"]
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data"]
