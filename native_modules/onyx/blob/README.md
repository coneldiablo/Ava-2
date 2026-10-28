# MinIO Community source-built QA image

This directory defines a non-root MinIO image for disposable AVA Onyx QA. It is not a production-ready image and does not establish buyer acceptance.

## Fixed upstream source

- Repository: <https://github.com/minio/minio>
- Release: [`RELEASE.2025-10-15T17-29-55Z`](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)
- Commit: [`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`](https://github.com/minio/minio/commit/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a)
- License: [GNU AGPL v3](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/LICENSE)

That release contains the fix for [GHSA-jjjj-jwhf-8rgr](https://github.com/minio/minio/security/advisories/GHSA-jjjj-jwhf-8rgr), the session-policy privilege-escalation issue affecting service and STS accounts. The older `RELEASE.2025-07-23T15-54-02Z` binary is not an acceptable new-pilot baseline.

MinIO Community is now source-only, and the upstream repository was archived on 25 April 2026. The archive status makes ongoing vulnerability review and an explicit maintenance or replacement decision mandatory; this image must not be described as a maintained upstream binary distribution.

## Controlled build input

Fetch the release source outside this repository. Verify the downloaded archive SHA-256 against the independently approved release-input manifest, record the archive hash and extracted-tree identity in the QA evidence, and use the extracted upstream tree as the Docker build context. Do not copy a locally modified tree or an unverified third-party binary into the context.

The Dockerfile intentionally has no base-image defaults. Supply both images by digest:

```sh
docker build \
  --build-arg GO_BUILD_IMAGE='registry.example/golang@sha256:<64-hex-digest>' \
  --build-arg RUNTIME_IMAGE='registry.example/minimal-runtime@sha256:<64-hex-digest>' \
  -f /path/to/ava/native_modules/onyx/blob/Dockerfile \
  -t ava-onyx-minio:qa \
  /path/to/verified/minio-source
```

The caller must reject any build argument that does not match `name@sha256:<64 lowercase hex>`. Docker resolves `FROM` before a build-stage check can run, so the Dockerfile check is defense in depth, not a substitute for caller-side policy.

The build stage compiles MinIO and a fixed Go HTTP health probe. The runtime stage performs no network fetch, contains no `mc`, and runs as numeric UID/GID `1001:1001`. `/data` and `/home/minio` are created with that ownership. A bind-mounted host directory must also be prepared for UID/GID 1001; Dockerfile ownership cannot repair a bind mount.

The image contract is:

- entrypoint: `/usr/local/bin/minio`
- default command: `server /data`
- health endpoint: `http://127.0.0.1:9000/minio/health/live`
- writable data volume: `/data`

## Evidence still required

Before any production consideration, retain all of the following:

1. Independently verified source-archive SHA-256 and proof it resolves to the fixed commit.
2. Immutable build and runtime base-image digests, build log, SBOM, and reproducible binary/image digest.
3. A current vulnerability scan of the final image and its Go dependency graph, with reviewed exceptions rather than severity suppression.
4. Runtime proof that the process is UID/GID 1001, the root filesystem can be read-only, `/data` is writable, the health check passes, restart persistence works, and the image contains neither `mc` nor an old MinIO binary.
5. IAM regression testing for restricted service/STS accounts and AVA bucket isolation, plus credential rotation and recovery testing.
6. AGPL source-availability and notice obligations for every distributed image.

Passing the static tests in this repository proves only the declared build contract. It does not prove the supplied source hash, base contents, resulting binary, vulnerability status, runtime isolation, or production readiness.

## Source-built `mc` bootstrap client

`Dockerfile.mc` replaces the unavailable binary image with a build from the official [`minio/mc` `RELEASE.2025-08-13T08-35-41Z`](https://github.com/minio/mc/releases/tag/RELEASE.2025-08-13T08-35-41Z), commit [`7394ce0dd2a80935aded936b09fa12cbb3cb8096`](https://github.com/minio/mc/commit/7394ce0dd2a80935aded936b09fa12cbb3cb8096). Fetch and checksum-verify that source archive independently and use its extracted tree as the build context. Do not use a community rebuild or copy a downloaded `mc` executable.

Use the same digest-pinned `GO_BUILD_IMAGE` policy. `RUNTIME_IMAGE` must be a digest-pinned Alpine 3.22 image that supplies BusyBox `sh`, `cp`, `cmp`, and `mktemp`; the Dockerfile checks their presence without installing packages. The client entrypoint is `/usr/bin/mc`, while the recipe intentionally overrides it with `/bin/sh` for the fixed one-shot bootstrap script.

The client runs as root only inside that ephemeral private init service because it must read root-owned `0600` bootstrap mounts. It is not the long-running object store and must retain `restart: "no"`, a read-only root filesystem, a bounded `/tmp` tmpfs, no published ports, and no placement in application services.

Credentials must remain in the existing mounted files. The admin alias comes from `/run/ava/mc-config.json`; runtime user credentials are consumed from `/run/ava/minio-runtime-credentials` on standard input. Never interpolate either secret into Compose `command`, process arguments, image layers, logs, or test output.

Example build after external source verification:

```sh
docker build \
  --build-arg GO_BUILD_IMAGE='golang@sha256:<approved-64-hex-digest>' \
  --build-arg RUNTIME_IMAGE='alpine@sha256:<approved-64-hex-digest>' \
  -f /path/to/ava/native_modules/onyx/blob/Dockerfile.mc \
  -t ava-onyx-mc:qa \
  /path/to/verified/mc-source
```

The final `mc` image and its Go dependency graph require their own SBOM and vulnerability scan. The server release fixing GHSA-jjjj-jwhf-8rgr does not imply that this older client dependency graph is clean.
