# Stonehush Decision Gates

Status: active

Decision gates settle cross-cutting behavior before the milestone needs it. Record each completed gate as one or more ADRs with executable acceptance cases.

Record the gate decision before its dependent issue begins.

## D0: Repository policy

Required for M0.

Accepted baseline:

- AGPL-3.0 project license.
- English repository artifacts and product copy.
- Private GitHub development repository owned by the project owner.
- pnpm workspace, Node.js 24, strict TypeScript, React/Fastify/SQLite architecture.
- Bootstrap is the only direct `main` commit; subsequent changes use owner-reviewed squash merges.

Before M0 closes, verify which branch rules and security features are available and document manual substitutes for unavailable controls.

## D1: Target normalization, saved scope, and warnings

Required before M2.

Status: accepted in [ADR-0001](./0001-target-normalization-scope-warnings.md).

Decide and test:

- hostname and domain normalization;
- IDNA and Unicode handling;
- trailing dots and case;
- IPv4 and IPv6 normalization;
- IPv4-mapped IPv6 addresses;
- IPv6 zone identifiers;
- URL userinfo and fragments;
- default ports;
- origin scheme/host/port semantics;
- host rules intersected with optional port rules;
- how domain targets expand to resolved IPs for non-HTTP tools;
- DNS resolution lifetime and resolution-time evidence;
- rebinding behavior;
- redirect hop, scheme, host, and port recording;
- shared/CDN address behavior;
- thresholds for large CIDR/target warnings and streaming expansion;
- which target/options snapshot governs retry;
- semantics for `Continue`, engagement auto-continue, and `Add to scope & run`;
- how one acknowledgment covers later DNS answers and redirects in the same run;
- warning event and evidence metadata.

Scope organizes target context. Every representable action remains runnable. An outside-scope or unusually large action may show one warning, with `Continue` as the primary path for the full run. Adding targets to saved scope stays optional. Shared and CDN destinations are recorded clearly and saved scope changes only through an explicit action.

## D2: Actions, runs, concurrency, and runner trust

Required before M3.

Status: accepted in [ADR-0002](./0002-actions-runs-runner-trust.md).

### State and concurrency

Decide:

- idempotency keys and replay results for action creation, warning acknowledgment, continuation, retry, runner event append, and completion;
- optimistic concurrency or revision checks for mutable resources;
- valid Action and Run transitions;
- one terminal transition per run;
- retry creation without prior-run mutation;
- deterministic late-event rejection;
- SSE event IDs, retention, resume, and expired-cursor behavior;
- SQLite busy timeout, transaction boundaries, and single-writer expectations.

### Runner identity and protocol

Decide:

- first enrollment and explicit owner confirmation;
- identity and protocol/version handshake;
- exact-version matching or supported compatibility window;
- token entropy, creation, presentation, client storage, server hashing, rotation, revocation, and recovery;
- least-privilege runner API boundary;
- lease duration, heartbeat, expiry, fencing token, and replay behavior;
- recovery of work after runner or control-plane restart;
- concurrency and admission limits.

### Process execution

Decide:

- installed-plugin executable registry and recording of the resolved executable path/version;
- external binary version policy;
- minimal predictable environment policy;
- working directory ownership and lifecycle;
- user/group and Linux service hardening;
- timeout and cancellation escalation deadlines;
- process-group behavior;
- operator-configurable CPU, memory, process, file, duration, and output controls, including unlimited modes where technically possible;
- stdout/stderr backpressure and truncation metadata;
- secret and flag redaction.

Permanent invariants:

- the operator owns target, purpose, and risk decisions;
- the runner spawns an executable with an argv array;
- event append requires the current lease and fencing token;
- cancellation targets the process group;
- partial evidence remains truthful.

## D3: Evidence durability, privacy, and recovery

Required before M3 evidence publication and completed before M9 backup/restore.

Status: accepted in [ADR-0003](./0003-evidence-publication-recovery.md).

Decide:

- staging, hashing, fsync, and atomic publication flow;
- behavior across filesystem boundaries;
- per-artifact, per-run, and total storage quotas;
- generated path scheme;
- traversal, symlink, and hardlink defenses;
- content type as untrusted metadata;
- safe download `Content-Type` and `Content-Disposition` behavior;
- whether ranges are supported and how active content is prevented from executing;
- raw versus parsed evidence linkage;
- truthful partial/truncated evidence metadata;
- secret, token, API-key, and flag redaction;
- manual retention, deletion, and export behavior;
- orphan, missing, extra, and corrupt artifact detection;
- a consistent SQLite plus artifact snapshot protocol;
- restore into an empty data directory;
- ownership, permissions, version compatibility, and migration after restore.

Accepted v0.1 baseline: evidence is stored as plaintext under filesystem permissions, with documented and rehearsed backup/restore.

Runs and parsers cannot rewrite immutable artifacts. Owner retention and deletion use a separate documented operation.

## D4: Browser and network access

Required before non-loopback binding is supported.

Decide and test:

- first access-token creation and one-time display;
- storage, rotation, revocation, expiry, and recovery;
- browser session exchange and `HttpOnly`, `Secure`, and `SameSite` behavior;
- CSRF protection for state-changing routes;
- strict Origin and Host validation;
- closed CORS policy;
- SSE authentication without bearer tokens in URLs or logs;
- invalidation after token rotation;
- body-size and rate limits;
- security headers;
- safe evidence and report download behavior;
- Markdown and print-HTML sanitization;
- reverse-proxy and TLS termination assumptions.

M1 ships with loopback access. Completing this gate adds LAN access with an explicit browser security model.

## D5: Plugin protocol and installation

Required before local community plugin installation is enabled.

First prove the process protocol with multiple first-party adapters. Then decide:

- manifest, protocol, and event versioning;
- compatibility and actionable failure behavior;
- immutable installed copy and digest;
- required external binary discovery and versioning;
- declared host-requirement vocabulary and one-confirmation install UI;
- enable, disable, and remove behavior;
- provenance retained for historical runs;
- source path, traversal, and symlink rejection;
- per-run plugin digest pinning;
- update policy;
- schema-driven UI contribution limits;
- resource and output limits shared with the runner.

v0.1 plugins contribute schema-driven UI and update through explicit reinstall.

## D6: Advisor model and data-flow boundary

Required before M8.

Permanent invariants:

- the operator remains the decision-maker;
- model capability execution uses the same warning and continuation path as human actions;
- capabilities are explicit and inspectable, and any installed plugin action can be exposed without a hard-coded safe-action list;
- installed capabilities define model access to actions, files, and stored data;
- model, plugin, network, and evidence text is untrusted;
- only the least necessary data leaves the control plane;
- every installed action remains runnable; T2/T3/T4 use at most one `Continue` card according to engagement warning preferences.

Decide and test:

- field-level data classification;
- fields excluded from model requests;
- flag, token, secret, and evidence redaction;
- public-endpoint detection, warning, and per-endpoint opt-in;
- redirect, DNS, proxy, and private-address handling for model endpoints;
- API-key environment-variable resolution and logging rules;
- operator-configurable request, response, context, tool-call, run, time, and output controls, including unlimited modes where technically possible;
- streaming cancellation;
- audit metadata that proves what categories and evidence references were supplied without logging secrets;
- UI-history and log retention;
- capability-call idempotency and single-confirmation continuation;
- prompt-injection treatment across turns;
- native tool-calling requirements;
- strict-JSON fallback, parse-error visibility, retry, and raw-response behavior;
- streaming format and provider compatibility errors;
- abstention and evidence-citation contract.

The tested compatibility profile defines what Stonehush means by "OpenAI-compatible."

## D7: Packaging, supply chain, and public release

Required before M10, with backup/restore completed during M9.

Decide and implement:

- pinned Node and package-manager versions;
- committed lockfile and frozen CI installs;
- supported Linux distribution/version matrix;
- dependency update cadence;
- direct and transitive license inventory compatible with AGPL distribution;
- third-party asset notices;
- least-privilege workflow permissions;
- immutable SHA pinning for third-party GitHub Actions;
- migration compatibility window;
- append-only published migrations;
- control-plane/runner compatibility rules;
- clean install and upgrade tests;
- rehearsed consistent backup and restore;
- doctor verification;
- checksums and SBOM;
- immutable tags;
- signing and provenance requirements;
- vulnerability reporting and supported-version policy.

Nightlies may start after M4 only when they have an installable consumer. They are prereleases from reviewed `main`, skip unchanged revisions, record the exact commit, and never write version bumps to the repository.

Stable release creation, publication, and announcement are manual owner decisions.
