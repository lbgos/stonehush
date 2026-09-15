<img src="apps/web/public/brand/stonehush-wordmark.svg" width="280" alt="stonehush">

A local-first workspace for security assessments, CTFs, and labs.

I'm building it for my own security work: keep targets, scans, evidence, notes, and reports together. Less moving things between tools, more time understanding the target. If it helps you with internal assessments or client work too, I'd like your input.

## What it does

- Nmap service discovery, HTTP probing, and ffuf path discovery.
- Saved run history, output, and evidence per engagement.
- Markdown notes, findings, and reports exported as Markdown or JSON.
- Saved scope with warnings you can acknowledge and continue past.
- Optional [AI evidence explanations](docs/operator/advisor-setup.md) using your own compatible endpoint.

Runs on your Linux machine with a browser UI, SQLite, and local evidence files. External AI providers receive the evidence you select.

**Early development.** Local, single-user use. Some screens are unfinished, and runner setup is still manual. No packaged installer yet.

## Quick start

Requires Linux with glibc 2.28+, Node.js 24, pnpm 10.24.0, a C compiler (`cc`), and Node development headers (`node_api.h`).

```bash
git clone https://github.com/lbgos/stonehush.git
cd stonehush
pnpm install --frozen-lockfile
pnpm --filter @stonehush/evidence-native build
pnpm dev
```

Open <http://127.0.0.1:5173>. Data lives in `.stonehush/dev` by default. The native build is required for evidence and advisor turns.

This starts the UI and API. Scans also need a separately [enrolled runner](docs/architecture/0002-actions-runs-runner-trust.md), installed tools, and a wordlist for ffuf. For a one-command isolated lab, see the [guided demo](docs/operator/demo.md) (`pnpm demo`). In the [runner configuration](apps/runner/src/config.ts), set `STONEHUSH_API_BASE_URL` to `http://127.0.0.1:3001` for development.

## Try it

Use a dedicated lab and [tell me what breaks or gets in your way](https://github.com/lbgos/stonehush/issues). Include reproduction steps and your tested commit. Keep credentials and private target data out of reports.

Considering it for your business? Tell me what you'd need before adopting it. Stars and sharing help others find the project.

## Development

TypeScript, React, Vite, Tailwind CSS, Fastify, and SQLite. Run `pnpm check` for formatting, lint, types, tests, and builds.

[Plan](docs/development/V0.1_PLAN.md) · [Contributing workflow](docs/development/MAINTAINER_HANDBOOK.md) · [AGPL-3.0-only](LICENSE)
