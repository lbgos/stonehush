# AGENTS.md

These rules apply to every coding agent working in this repository.

## 1. Role and authority

The owner controls product intent, target and warning policy, architecture exceptions, repository settings, secrets, merges, and releases.

Agents inspect, propose, implement, test, and review bounded assignments. Do not turn implementation convenience into product policy or silently expand an issue.

Repository artifacts are written in English.

## 2. Read before editing

Read, in order:

1. the assigned issue or owner assignment;
2. this file and any more specific `AGENTS.md` under the target path;
3. [`docs/development/V0.1_PLAN.md`](./docs/development/V0.1_PLAN.md);
4. relevant decision gates, ADRs, contracts, implementation, and tests;
5. [`docs/development/MAINTAINER_HANDBOOK.md`](./docs/development/MAINTAINER_HANDBOOK.md) when the task involves workflow, review, or release behavior.

Prefer an existing abstraction over creating a parallel one. Check repository contracts and package boundaries before adding a new abstraction.

## 3. Work mode

Every assignment uses one mode:

- `PLAN`: inspect and propose; do not edit.
- `IMPLEMENT`: make only the assigned change and focused tests.
- `REVIEW`: report evidence-backed findings; do not edit.
- `FIX`: address only the specified findings.
- `RELEASE-PREP`: prepare evidence and notes; do not publish, tag, or merge.

If the owner clearly asks both for evaluation and a conditional change, review first and implement only when the stated condition is satisfied.

## 4. Agent orchestration

The primary agent keeps the owner context, defines bounded work, coordinates agents, verifies findings, handles small changes, and prepares the owner handoff.

Use this loop for substantial changes:

1. The primary agent writes a Ready issue or equivalent bounded assignment.
2. Review workers challenge the specification in read-only mode. Run independent acceptance, architecture, and test passes in parallel when useful.
3. One persistent implementer owns the substantial code change in its assigned worktree.
4. Run focused checks, then the repository baseline.
5. Review workers independently review the frozen diff and tests in read-only mode. Split correctness, test gaps, security, accessibility, or maintainability into separate passes when useful.
6. The primary agent verifies every finding against source and behavior. Model output is not accepted as evidence by itself.
7. Skip the fix phase when no valid findings remain. The primary agent handles small fixes. Return substantial fixes to the same implementer instead of spawning a new one.
8. Re-run affected checks and any required independent review.
9. The owner reviews the result and performs the squash merge.

Keep one writer per worktree. Multiple implementation agents may run concurrently only for independently mergeable assignments with separate branches, worktrees, data, ports, and non-overlapping ownership. Prefer parallel agents for read-only specification review, exploration, test analysis, and diff review. Early foundational changes that share workspace configuration, contracts, or lockfiles run sequentially.

Reuse the same implementer for implementation and substantial follow-up work within a PR. Continue with it across tightly related PRs while its context remains accurate. Do not spend a fresh implementation agent on a small correction that the primary agent can safely make and verify.

A review worker may draft candidate tests or fixtures in an isolated disposable worktree, but nothing is accepted without primary-agent review and execution. When review workers are unavailable as direct subagents, invoke one programmatically from the assigned worktree in read-only mode:

```bash
<agent-cli> run \
  --worktree <worktree> \
  --model <review-model> \
  --read-only \
  '<bounded review packet>'
```

Keep noisy exploration, raw logs, and repetitive review output out of the primary thread. Return concise summaries with file references, reproduction steps, and exact verification evidence.

## 5. Scope rules

- Work only on the assigned outcome and respect explicit non-goals.
- Do not change target-warning behavior, data access, plugin trust, model capabilities, runner privileges, supported platforms, public APIs, dependencies, licensing, or release semantics without owner approval.
- Do not mix unrelated cleanup, upgrades, refactors, or formatting into a change.
- Stop when implementation requires an unresolved decision gate or crosses more architectural boundaries than the issue anticipated.
- One PR has one independently reviewable reason to exist.

## 6. Product invariants

Stonehush is a fast operator tool for CTFs, labs, and assessments.

- Scope organizes targets, filters, evidence, and reports. Every representable action stays runnable.
- An out-of-scope, redirected, newly resolved, or noisy action may show one concise confirmation, but `Continue` always remains available.
- Continuing records the warning and exact target context; it does not silently rewrite the saved scope.
- Risk tiers are informational labels used to choose warning copy and defaults. They do not prohibit execution.
- Human and advisor-triggered actions use the same warning path. Neither needs a second approval workflow after the operator continues.
- The v0.1 model uses typed capabilities for installed actions and data access.
- Model output, plugin output, network data, filenames, metadata, and evidence content are untrusted input.

## 7. Execution and evidence invariants

- Spawn an explicitly configured executable with an argv array. Never execute shell command strings.
- The runner executes the selected installed plugin with explicit executable and argv handling, a controlled working directory, resource limits, and process-group cancellation.
- Expired or superseded leases cannot append results.
- Output is bounded and backpressured; cancellation and failure preserve truthful partial evidence.
- Artifact paths are generated by the control plane and cannot escape managed storage through traversal, symlinks, or hardlinks.
- Raw evidence is immutable to runs and parsers, content-addressed, and never silently replaced.
- Secrets, API keys, tokens, flags, and sensitive command arguments are redacted from prompts, logs, fixtures, screenshots, artifacts, commits, and PR text.

Do not weaken process, credential, evidence, or data-integrity protections to make a test pass. Do not convert an informational product warning into a hidden authorization gate.

## 8. Repository architecture

The planned package boundaries are:

```text
apps/web          React client
apps/api          Fastify control plane
apps/runner       native host runner
packages/contracts  shared Zod/API/event contracts
packages/domain     pure rules and state transitions
packages/db         Drizzle schema, repositories, migrations
packages/plugin-sdk manifest and NDJSON protocol contracts
packages/ui         Stonehush-owned UI primitives
plugins/*           first-party tool adapters
```

Public contracts originate in `packages/contracts`. Target-warning behavior and state transitions belong in `packages/domain`. Frontend, API, runner, and plugins must not redefine these rules independently.

## 9. Git authority

Unless the owner explicitly authorizes otherwise:

- do not push;
- do not create or modify remote branches, issues, PRs, labels, milestones, repository settings, or releases;
- do not rebase or force-push a shared branch;
- never push directly to `main`;
- never merge a PR or publish a release;
- do not create or rotate credentials, tokens, signing keys, or secrets.

Never discard owner changes or another agent's work. Never use destructive Git or filesystem commands merely to obtain a clean state.

## 10. Verification

Run the smallest proof that covers the changed behavior. Name exact commands and results.

Add negative and adversarial tests where the change touches:

- target normalization, warnings, and continue behavior;
- state transitions;
- leases, retries, cancellation, idempotency, and concurrency;
- argv/process execution and environment handling;
- paths, symlinks, artifacts, and output limits;
- untrusted plugin/model/network content;
- authentication, secrets, and redaction.

For user-visible changes, capture before/after screenshots. Capture a short recording for motion, timing, resizing, or interaction behavior. Source inspection alone is not visual verification.

Use reserved addresses, synthetic domains, fixtures, and dedicated labs. Never point tests at real targets or owner/live data.

## 11. Stop conditions

Return to the owner instead of guessing when:

- product intent or a security boundary is ambiguous;
- a required ADR or decision gate is unresolved;
- requested behavior conflicts with repository policy;
- a dependency, license, public API, migration policy, or supported-platform change is required but not approved;
- a destructive or irreversible operation appears necessary;
- verification would require real assessment targets, production secrets, or live owner data.

## 12. Handoff

Report:

1. outcome;
2. changed paths;
3. decisions and assumptions;
4. exact verification commands and results;
5. screenshots or recordings when applicable;
6. risks and follow-ups;
7. anything not verified;
8. proposed Conventional Commit PR title.

PR descriptions are written for the whole project, not for the owner's current machine. An `Owner walkthrough` section is optional and omitted by default. Never include owner-specific worktree paths, occupied ports, running-process assumptions, or instructions addressed only to the owner. When a walkthrough materially improves review, write portable steps that any contributor can follow from a clean checkout and use placeholders for environment-specific paths and ports.

High-risk changes require an independent review agent from a clean context and owner review of the security boundary. The implementing agent cannot self-approve that risk.
