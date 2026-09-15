# M1 Executable Shell Status

Verified: 2026-08-08

## Current behavior

- `pnpm dev` validates its ports and absolute data-directory configuration, starts the API first, waits for the exact loopback health response, and then starts Vite.
- Development storage defaults to `.stonehush/dev` under the repository. Startup creates it privately when missing and rejects symbolic links, non-directories, wrong ownership, broad permissions, and failed exclusive write probes.
- The API remains loopback-only. `GET /health` returns exactly `{"status":"ok"}`. `GET /api/v1/system/status` returns the strict shared readiness contract without paths or raw errors.
- Vite proxies `/api` to the local API. The dashboard distinguishes loading, ready, not-ready, unavailable, and cached last-known states without polling or automatic retries.
- The responsive shell, theme preference, Settings appearance control, component gallery, and stable loading, empty, stale, recoverable-error, and fatal-error examples are available.

## Verification

`pnpm check` passes formatting, syntax and documentation checks, strict workspace typechecking, unit and smoke tests, and production builds.

M1 is complete. M2 begins with Decision Gate D1 and engagement/target context.
