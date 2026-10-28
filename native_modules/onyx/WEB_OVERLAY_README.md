# Onyx web SSR overlay

`install_web.py` is a **source-build-only** overlay for the pinned Onyx
`v4.7.0` checkout. It must run after the upstream web source is present and
before the upstream `web/Dockerfile` compiles the Next standalone output.

It does not work against a released `onyx-web-server` runtime image: that
image contains compiled Next output, not `web/src` or Python. Do not copy this
overlay into a running container and do not treat its files as a runtime patch.

The installer requires `AVA_EXTENSION_BUILD=1` and hashes all three upstream
SSR source files before making any change. It then forwards only the
gateway-injected `x-ava-native-peer` and `x-ava-native-binding` headers during
SSR; it never invents either header, a cookie, a user, or auth metadata.

A second run against the same tree fails closed with
`INSTALLED_UPSTREAM_WEB_SOURCE_MISMATCH`, because the original pinned hashes no
longer match. Rebuild from a fresh pinned source checkout instead. The needed
flow is:

1. Obtain and verify the source at the commit in `upstreams.lock.json`.
2. Place `upstreams.lock.json` and `avaSS.ts` in the installer asset directory.
3. Run `AVA_EXTENSION_BUILD=1 python install_web.py` with the source checkout
   as `/app` (or pass explicit paths to `install()` in build automation).
4. Build the resulting source tree with the original upstream `web/Dockerfile`.

This establishes only source-overlay correctness. It does not prove a browser
journey, native login, or production readiness.
