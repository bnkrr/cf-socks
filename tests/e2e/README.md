# End-to-End Tests

Real E2E tests live under `tests/e2e` because they validate deployed component
boundaries instead of one package.

- `go/` covers Go SDK and local SOCKS agent flows.
- `direct/` covers curl-only Direct endpoint flows.
- `run.sh` loads shared environment and runs all real E2E suites.
- `deploy-temporary.sh` creates a temporary Worker for manual E2E runs.

Required environment:

```bash
export E2E_WORKER_URL=https://<worker-host>
export E2E_AUTH_SECRET=<auth secret>
export E2E_DIRECT_BEARER=<direct bearer>
tests/e2e/run.sh
```

Optional targets use `host:port` values: `E2E_HTTP_TARGET`,
`E2E_HTTPS_TARGET`, and `E2E_TCP_BANNER_TARGET`.
