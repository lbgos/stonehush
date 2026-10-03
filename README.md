<img src="apps/web/public/brand/stonehush-wordmark.svg" width="280" alt="stonehush">

A local-first workspace for security assessments, CTFs, and labs.

I'm building it for my own security work: keep targets, scans, evidence, notes, and reports together. Less moving things between tools, more time understanding the target. If it helps you with internal assessments or client work too, I'd like your input.

## What it does

- Nmap service discovery, HTTP probing, and ffuf path discovery from Surface, with follow-up actions on the selected result.
- Saved scope with one concise warning. `Continue` always runs the exact action without changing saved scope.
- Runs with cancel and retry, raw output viewing, and immutable evidence per engagement.
- Leads with attempts, kept excerpts, park reasons, and linked findings. Surface keeps the source under the form.
- Findings with saved evidence references, and a report that exports Markdown or JSON with a sharing preview.
- Resume with a saved next step and recent changes, engagement search over notes and findings, and per-engagement techniques saved from selected lead attempts with review. Open the engagement's Techniques tab to search saved procedures, fill placeholders, and copy a replay. Known secret patterns show as [redacted]; review the rest before saving.
- Optional [AI evidence explanations](docs/operator/advisor-setup.md) using your own compatible endpoint. The model receives your question plus the excerpts and findings you select, with bounded prior succeeded turns in the same engagement.

Runs on your Linux machine with a browser UI, SQLite, and local evidence files. Scratchpad text, credentials, secret values, note history, and raw artifact bytes stay out of model requests.

**Early development.** Local, single-user use. Some screens are unfinished. No packaged installer yet.

## Screenshots

Captured from the running app with synthetic local lab data.

Discover HTTP paths with ffuf and inspect the saved evidence for each result.

![HTTP path discovery with status codes, response sizes, and raw evidence links](https://files.lbgos.dev/f/59f3533e54fff819b82a902d34a8d66c/stonehush-path-discovery-3bfa14ee.png)

Add findings to the report outline with their saved evidence. Unavailable references stay visible and are not added.

![Report outline with findings, evidence availability, and add with evidence controls](https://files.lbgos.dev/f/a63d6c3e577976c0c1312e0969cf2190/report-finding-evidence-camoufox-selected-1440-2494897c.png)

Review findings in the engagement report, then export Markdown or JSON.

![Engagement report with a saved finding, Markdown preview, and export controls](https://files.lbgos.dev/f/433d3fd19a510aa3807312785019ef18/stonehush-report-f02da90c.png)

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

Start the runner in a second shell once the API is up:

```bash
pnpm runner:dev
```

It checks for `nmap`, waits for the dev API at `http://127.0.0.1:3001`, and keeps the secret in memory only. When both credential variables are unset or empty, it enrolls with owner confirmation. It revokes the identity it created after stopping its owned runner. A valid `STONEHUSH_RUNNER_ID` and `STONEHUSH_RUNNER_SECRET` pair skips enrollment and revocation. A partial or malformed pair fails validation. A fresh shell enrolls again after successful cleanup. Uncertain enrollment or failed cleanup needs explicit operator recovery. See [runner startup](docs/operator/runner-startup.md).

This starts the UI, API, and runner. Scans also need installed tools and a wordlist for ffuf. For a one-command isolated lab, see the [guided demo](docs/operator/demo.md) (`pnpm demo`).

## Try it

Use a dedicated lab and [tell me what breaks or gets in your way](https://github.com/lbgos/stonehush/issues). Include reproduction steps and your tested commit. Keep credentials and private target data out of reports.

Considering it for your business? Tell me what you'd need before adopting it. Stars and sharing help others find the project.

## Development

TypeScript, React, Vite, Tailwind CSS, Fastify, and SQLite. Run `pnpm check` for formatting, lint, types, tests, and builds.

[Plan](docs/development/V0.1_PLAN.md) · [Contributing workflow](docs/development/MAINTAINER_HANDBOOK.md) · [AGPL-3.0-only](LICENSE)
