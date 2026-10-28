import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1] / "native_modules" / "onyx" / "blob"
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
MC_DOCKERFILE = (ROOT / "Dockerfile.mc").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
RELEASE = "RELEASE.2025-10-15T17-29-55Z"
COMMIT = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
MC_RELEASE = "RELEASE.2025-08-13T08-35-41Z"
MC_COMMIT = "7394ce0dd2a80935aded936b09fa12cbb3cb8096"


class OnyxBlobImageContractTests(unittest.TestCase):
    def test_builds_exact_security_release_from_supplied_source(self):
        self.assertIn("COPY . /src", DOCKERFILE)
        self.assertIn("go build", DOCKERFILE)
        self.assertIn(f"cmd.ReleaseTag={RELEASE}", DOCKERFILE)
        self.assertIn(f"cmd.CommitID={COMMIT}", DOCKERFILE)
        self.assertIn(f'org.opencontainers.image.version="{RELEASE}"', DOCKERFILE)
        self.assertIn(f'org.opencontainers.image.revision="{COMMIT}"', DOCKERFILE)
        self.assertNotIn("RELEASE.2025-07-23", DOCKERFILE)
        self.assertIn("GOMAXPROCS=2", DOCKERFILE)
        self.assertIn("GOMEMLIMIT=1536MiB", DOCKERFILE)
        self.assertEqual(DOCKERFILE.count("go build -p 2"), 2)

    def test_bases_are_required_caller_arguments_and_digest_checked(self):
        self.assertRegex(DOCKERFILE, r"(?m)^ARG GO_BUILD_IMAGE$")
        self.assertRegex(DOCKERFILE, r"(?m)^ARG RUNTIME_IMAGE$")
        self.assertNotRegex(DOCKERFILE, r"(?m)^ARG (?:GO_BUILD_IMAGE|RUNTIME_IMAGE)=")
        self.assertIn("FROM ${GO_BUILD_IMAGE} AS build", DOCKERFILE)
        self.assertIn("FROM ${RUNTIME_IMAGE} AS runtime", DOCKERFILE)
        self.assertGreaterEqual(DOCKERFILE.count("@sha256:"), 3)
        self.assertIn('test "${#go_pin}" -eq 64', DOCKERFILE)
        self.assertIn('test "${#runtime_pin}" -eq 64', DOCKERFILE)
        self.assertIn('*[!0-9a-f]*) exit 64', DOCKERFILE)
        self.assertIn("exit 64", DOCKERFILE)
        self.assertIn('test "$(go env GOVERSION)" = "go1.24.8"', DOCKERFILE)

    def test_runtime_has_no_fetch_or_package_install(self):
        runtime = DOCKERFILE.split("FROM ${RUNTIME_IMAGE} AS runtime", 1)[1]
        self.assertNotRegex(runtime, r"(?m)^RUN ")
        self.assertNotRegex(runtime, r"(?m)^ADD ")
        self.assertNotRegex(runtime, r"(?im)^(?:RUN|ENTRYPOINT|CMD).*\b(?:curl|wget|apk|apt|dnf|yum)\b")
        self.assertNotIn("/usr/bin/mc", runtime)

    def test_runtime_is_non_root_with_owned_writable_paths(self):
        self.assertIn("COPY --from=build --chown=1001:1001 /out/data/ /data/", DOCKERFILE)
        self.assertIn("COPY --from=build --chown=1001:1001 /out/home/ /home/minio/", DOCKERFILE)
        self.assertIn("USER 1001:1001", DOCKERFILE)
        self.assertIn('VOLUME ["/data"]', DOCKERFILE)
        user_at = DOCKERFILE.index("USER 1001:1001")
        self.assertNotRegex(DOCKERFILE[user_at:], r"(?m)^USER (?:0|root)(?::|$)")

    def test_fixed_healthcheck_does_not_assume_mc_or_shell(self):
        self.assertIn('client.Get("http://127.0.0.1:9000/minio/health/live")', DOCKERFILE)
        self.assertIn('HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/usr/local/bin/minio-healthcheck"]', DOCKERFILE)
        self.assertNotRegex(DOCKERFILE, r"HEALTHCHECK[^\n]*(?:mc|curl|wget|sh -c)")

    def test_entrypoint_and_default_command_match_caller_contract(self):
        self.assertIn('ENTRYPOINT ["/usr/local/bin/minio"]', DOCKERFILE)
        self.assertIn('CMD ["server", "/data"]', DOCKERFILE)

    def test_official_source_license_and_provenance_labels_are_present(self):
        for expected in (
            'org.opencontainers.image.source="https://github.com/minio/minio"',
            'org.opencontainers.image.licenses="AGPL-3.0-only"',
            "COPY --from=build --chown=0:0 --chmod=0444 /src/LICENSE /licenses/LICENSE",
        ):
            self.assertIn(expected, DOCKERFILE)

    def test_documentation_is_explicitly_qa_only_and_lists_unproved_gates(self):
        lower = README.lower()
        self.assertIn("not a production-ready image", lower)
        self.assertIn("source-only", lower)
        self.assertIn("archived", lower)
        self.assertIn("vulnerability scan", lower)
        self.assertIn("source-archive sha-256", lower)
        self.assertIn("reproducible binary/image digest", lower)
        self.assertIn("does not prove", lower)
        self.assertIn("agpl", lower)
        self.assertNotIn("production ready", lower.replace("not a production-ready", ""))


class OnyxBlobClientImageContractTests(unittest.TestCase):
    def test_builds_exact_official_mc_source_release(self):
        self.assertIn("COPY . /src", MC_DOCKERFILE)
        self.assertIn("go build", MC_DOCKERFILE)
        self.assertIn(f"cmd.ReleaseTag={MC_RELEASE}", MC_DOCKERFILE)
        self.assertIn(f"cmd.CommitID={MC_COMMIT}", MC_DOCKERFILE)
        self.assertIn(f'org.opencontainers.image.version="{MC_RELEASE}"', MC_DOCKERFILE)
        self.assertIn(f'org.opencontainers.image.revision="{MC_COMMIT}"', MC_DOCKERFILE)
        self.assertIn("GOMAXPROCS=2", MC_DOCKERFILE)
        self.assertIn("GOMEMLIMIT=1536MiB", MC_DOCKERFILE)
        self.assertEqual(MC_DOCKERFILE.count("go build -p 2"), 1)

    def test_mc_bases_are_required_and_exactly_digest_checked(self):
        self.assertRegex(MC_DOCKERFILE, r"(?m)^ARG GO_BUILD_IMAGE$")
        self.assertRegex(MC_DOCKERFILE, r"(?m)^ARG RUNTIME_IMAGE$")
        self.assertNotRegex(MC_DOCKERFILE, r"(?m)^ARG (?:GO_BUILD_IMAGE|RUNTIME_IMAGE)=")
        self.assertIn("FROM ${GO_BUILD_IMAGE} AS build", MC_DOCKERFILE)
        self.assertIn("FROM ${RUNTIME_IMAGE} AS runtime", MC_DOCKERFILE)
        self.assertIn('test "${#go_pin}" -eq 64', MC_DOCKERFILE)
        self.assertIn('test "${#runtime_pin}" -eq 64', MC_DOCKERFILE)
        self.assertIn('*[!0-9a-f]*) exit 64', MC_DOCKERFILE)
        self.assertIn('test "$(go env GOVERSION)" = "go1.24.8"', MC_DOCKERFILE)

    def test_mc_runtime_has_busybox_contract_without_fetching_packages(self):
        runtime = MC_DOCKERFILE.split("FROM ${RUNTIME_IMAGE} AS runtime", 1)[1]
        self.assertIn('for tool in sh cp cmp mktemp', runtime)
        self.assertNotRegex(runtime, r"(?im)^RUN .*\b(?:curl|wget|apk|apt|dnf|yum)\b")
        self.assertNotRegex(runtime, r"(?m)^ADD ")
        self.assertIn("COPY --from=build --chown=0:0 --chmod=0555 /out/mc /usr/bin/mc", runtime)

    def test_mc_is_explicit_ephemeral_root_init_client(self):
        self.assertIn("USER 0:0", MC_DOCKERFILE)
        self.assertIn('ENTRYPOINT ["/usr/bin/mc"]', MC_DOCKERFILE)
        self.assertIn('CMD ["--help"]', MC_DOCKERFILE)
        lower = README.lower()
        self.assertIn("ephemeral private init service", lower)
        self.assertIn('restart: "no"', lower)
        self.assertIn("read-only root filesystem", lower)

    def test_mc_credentials_are_never_baked_or_put_in_arguments(self):
        for forbidden in ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "minio-runtime-credentials", "mc-config.json"):
            self.assertNotIn(forbidden, MC_DOCKERFILE)
        self.assertIn("consumed from `/run/ava/minio-runtime-credentials` on standard input", README)
        self.assertIn("Never interpolate", README)

    def test_mc_license_and_unproved_security_gates_are_explicit(self):
        self.assertIn('org.opencontainers.image.source="https://github.com/minio/mc"', MC_DOCKERFILE)
        self.assertIn('org.opencontainers.image.licenses="AGPL-3.0-only"', MC_DOCKERFILE)
        self.assertIn("COPY --from=build --chown=0:0 --chmod=0444 /src/LICENSE /licenses/LICENSE", MC_DOCKERFILE)
        lower = README.lower()
        self.assertIn("own sbom and vulnerability scan", lower)
        self.assertIn("does not imply", lower)


if __name__ == "__main__":
    unittest.main()
