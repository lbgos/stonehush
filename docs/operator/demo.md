# Guided demo lab

One command starts an isolated stack plus a benign loopback fixture, runs real Nmap, HTTP probe, and ffuf against only the fixture port, then records a finding, notes, and an exported report.

```bash
pnpm install --frozen-lockfile
pnpm --filter @stonehush/evidence-native build
pnpm demo
pnpm demo -- --smoke
```

Prerequisites: the README toolchain plus installed `nmap` (`/usr/bin/nmap`, used for the discovery scan) and `ffuf` (`/usr/bin/ffuf`, used for content discovery with a generated 4-entry wordlist). The demo checks both binaries before starting and refuses to run when either is missing; a tool that breaks mid-run still surfaces as a truthful run failure.

Open the printed UI URL. Keep the app alive until Ctrl+C; only processes started by the demo are cleaned up.

Defaults: API `127.0.0.1:3286`, web `127.0.0.1:5286`, fixture `127.0.0.1:43860`, fresh data dir under `.stonehush/demo-<timestamp>`. Daily-driver ports `3001`/`5173` and storage `.stonehush/dev` are refused. Flags pass after `--`: `--smoke` proves the pipeline then stops with a truthful exit code, `--api-port`, `--web-port`, `--fixture-port`, `--data-dir` (absolute path). Reruns keep prior data; every default run starts fresh and nothing is ever deleted.

Runner credentials stay in memory; no secret is printed and no credential file is written. Everything scanned is loopback; the fixture serves two static demo pages and the wordlist has four entries. Notes require the live revision and fail rather than overwrite on conflict. Any unexpected child exit fails the run truthfully; the persistent app also watches child health while running. Advisor setup stays manual and is not claimed by this demo.
