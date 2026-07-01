# Changelog

## v0.7.0

### Added

- Added profile-based Worker bundles for dashboard deployment: `full`, `wss-only`, `direct-connect`, and `url-full`.
- Added `/direct-url?target=...` static-bearer URL ingress for curl-friendly TCP connect and `fetch()` egress checks.
- Added Worker-to-target TLS control with `tls=on` for Direct URL TCP targets and `TLSOn` / `WithTLS` in the Go SDK.
- Added Direct URL E2E coverage for TCP HTTP, fetch, TLS-to-target HTTP, and H3 direct flows.

### Changed

- Refactored Worker internals around separate auth, ingress, egress, profile, and response modules.
- Replaced the single dashboard bundle with profile-specific generated bundles and release assets.
- Updated README and protocol docs around Direct URL, target TLS, generated bundles, and profile selection.

### Compatibility

- Existing WSS, H2/H3, SOCKS, HTTP CONNECT, Go SDK, and `/direct/:host/:port` flows remain available in the `full` Worker profile.
- Dashboard users should copy `worker/single-file/full.js` for the full feature set instead of the removed `worker/single-file.js`.
- Target TLS is opt-in; normal SOCKS-style HTTPS tunneling should leave it off so the original client performs TLS inside the TCP stream.

## v0.6.0

### Added

- Added `write_close_after` for bounded H2/H3 `Do` and Direct payload exchanges.
- Added Go SDK `WithWriteCloseAfter` for one-shot target write-side close timing.
- Added authenticated Worker `GET /__meta` capability endpoint for smoke tests and deployment checks.
- Added release notes to `CHANGELOG.md`.

### Changed

- Updated Direct SSH/banner examples and E2E tests to use explicit write-close timing.
- Updated the release workflow to publish curated changelog sections instead of commit-list-only notes.
- Fixed release asset publishing so one release job uploads all built artifacts.

### Compatibility

- Existing WSS `Dial`, SOCKS, HTTP CONNECT, H2/H3 `Do`, and Direct flows continue to work without configuration changes.
- `write_close_after` is disabled by default. Direct accepts `none`, `0`, and durations up to `10m`; Go SDK users omit the option to disable it.

## v0.5.0

### Added

- Added an HTTP CONNECT listener to the local agent.
- Added release assets for the agent and dashboard Worker bundle.

### Changed

- Kept SOCKS5, HTTP CONNECT, and SDK dialing on the shared WSS `Dial` path.

## v0.4.0

### Added

- Added the Direct endpoint for curl-friendly bounded TCP payload tests.

### Changed

- Refactored Worker relay routing around shared payload exchange handling.
- Updated documentation for Direct curl usage and deployment checks.

## v0.3.0

### Added

- Added pooled bounded-payload clients for higher H2/H3 throughput.
- Added `cmd/cfsbench` as a benchmark CLI.
- Added benchmark documentation and protocol model documentation.

### Changed

- Documented transport semantics for WSS `Dial` versus H2/H3 `Do`.

## v0.2.1

### Changed

- Refined SDK internals and documentation after the v0.2.0 SDK and transport update.
- Cleaned up project layout and user-facing README wording.

## v0.2.0

### Added

- Added the Go SDK with explicit WSS, H2, and H3 transport selection.
- Added encrypted bearer-token authentication for SDK and Worker payload routes.
- Added H3 bounded-payload support.
- Added H3 examples and tests.

### Changed

- Rebuilt the SOCKS agent on top of SDK `Dial`.
- Replaced the old WSS first-frame auth model with encrypted token auth.

## v0.1.0

### Added

- Initial cf-socks release.
- Added Cloudflare Worker outbound TCP relay over WSS.
- Added local SOCKS5 agent.
- Added dashboard-copyable Worker bundle and basic tests.
