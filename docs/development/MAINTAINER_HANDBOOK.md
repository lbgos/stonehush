# Stonehush Maintainer Handbook

Status: active

Audience: solo owner and coding agents

This handbook is the working loop for issues, agents, reviews, and releases.

## 1. Operating model

The owner decides. Agents implement and review bounded work.

The owner owns:

- product intent and v0.1 scope;
- target-warning and risk-label policy;
- architecture exceptions and ADR approval;
- repository settings and secrets;
- dependency, license, public API, and platform decisions;
- merges and releases.

Agents may inspect, propose decomposition, implement assigned issues, add focused tests and evidence, draft documentation and PR text, and independently review another agent's change. Scope metadata and risk labels stay informational.

`main` remains releasable after bootstrap.

## 2. Unit of work

Use the smallest independently reviewable behavior. Diff size is secondary.

```text
milestone
  -> optional tracking issue
    -> implementable issue
      -> branch + worktree
        -> pull request
          -> squash merge
```

Tracking issues organize dependencies. Add epics or a project board when the issue list becomes difficult to scan.

Use 300 changed lines as a review warning. A cohesive 450-line parser may be safer than five coupled PRs, while a 40-line runner or credential change may still be high risk.

## 3. Ready issue contract

An implementation issue is Ready when it states:

- problem and affected user;
- one observable outcome;
- explicit non-goals;
- acceptance scenarios;
- expected packages or surfaces;
- security and privacy considerations;
- relevant decisions, contracts, and dependencies;
- verification and evidence expectations;
- migration and recovery expectations when applicable;
- work mode and Git authority;
- stop conditions.

Use `size:S`, `size:M`, `size:L`, and `size:split` only as review-burden hints. Risk and cohesion matter more than line count.

## 4. Agent assignment packet

Give the agent a bounded packet:

```text
Mode: IMPLEMENT | REVIEW | FIX | PLAN | RELEASE-PREP
Issue: #123 or explicit owner assignment
Goal: one observable outcome
Non-goals: explicit exclusions
Allowed paths: expected packages/directories
Contracts/ADRs: relevant sources of truth
Safety invariants: process/data protections and always-runnable product behavior
Acceptance: exact scenarios
Verification: focused commands and visual evidence
Git authority: local commit, push, or PR permissions
Stop conditions: decisions that return to the owner
```

Do not assign “build phase 7.” Convert a milestone into reviewable outcomes first.

## 5. Branches and worktrees

For concurrent implementation, use one issue, one branch, one worktree, and one implementing agent.

Branch names:

```text
feat/123-scope-revisions
fix/241-cancel-leased-run
docs/88-runner-threat-model
chore/19-ci-baseline
```

Branch from current `main` after the issue is Ready. Worktree paths should include the issue number.

Each worktree isolates:

- development data;
- ports;
- evidence storage;
- runner identity and tokens;
- test model configuration.

Never point development or tests at owner/live data or real assessment targets. Remove a merged worktree only after confirming it contains no unique changes.

## 6. Commits and merge strategy

Use squash merge. The PR title becomes the durable commit on `main`.

PR titles and meaningful working commits use plain-English Conventional Commits:

```text
feat(scope): warn without blocking outside saved scope
fix(runner): retain partial evidence after cancellation
docs(security): define runner token rotation
```

Working commits are implementation checkpoints. Fixup commits are acceptable while a PR is open because the final merge is squashed.


## 7. Pull requests

A PR contains enough evidence for the owner to decide whether it is safe.

Required sections:

1. **Problem and issue**
2. **Outcome / user-visible behavior**
3. **Scope and non-goals**
4. **Architecture and data flow**
5. **Security impact**
6. **Verification**: exact commands and results
7. **Migration and recovery**
8. **Owner walkthrough**
9. **Links**: issue, ADR, and dependencies

When applicable, add screenshots, recordings, compatibility notes, and agent disclosure. Avoid repetitive placeholder boilerplate.

Before review, confirm:

- the PR has one concern;
- acceptance scenarios and focused tests pass;
- contracts come from the correct package;
- process/data protections have negative tests and product warnings never become hidden execution gates;
- reverse lifecycle operations work where applicable;
- logs and fixtures contain no secrets or real targets;
- docs match behavior;
- UI evidence is from the branch under review;
- migrations and recovery are honest;
- the branch is current with `main`;
- required CI is green on the latest revision.

## 8. Review model

Review is risk-based.

### Low risk

Examples: documentation, copy, deterministic isolated test maintenance.

```text
implementer self-check -> owner diff review
```

### Medium risk

Examples: normal UI behavior, an ordinary API route, parser, or non-destructive persistence change.

```text
implementer self-check -> owner behavior review
```

Independent agent review is optional when it adds value.

### High risk

Examples:

- target normalization, warning, and continue behavior;
- risk labels and action state transitions;
- runner identity or execution;
- authentication and secrets;
- evidence paths and retention;
- plugin installation;
- model data flow and capability dispatch;
- destructive migration, backup/restore, or release automation.

```text
implementer
  -> independent agent review from clean context
  -> owner line-by-line review of the boundary
  -> dedicated-lab walkthrough
```

Write threat cases before high-risk implementation. Require negative and adversarial tests. The implementing agent may explain a disputed finding but cannot approve its own risk.

Finding severities:

- **Blocker:** data loss, secret exposure, command injection, an unavailable `Continue` path for a representable action, unrecoverable migration, or fundamentally wrong architecture.
- **High:** likely correctness or security failure in a supported flow.
- **Medium:** real defect or meaningful maintainability/performance regression.
- **Low:** bounded improvement that may be deferred.
- **Question:** intent or evidence is unclear.
- **Nit:** optional preference that does not block by itself.

Verify bot and agent findings against source and behavior. Neither approval nor rejection is accepted blindly.

## 9. Verification strategy

Local work runs the smallest proof that covers the change. CI owns the broad baseline.

Use:

- unit tests for pure domain rules and parsers;
- contract tests for REST, SSE, runner, and NDJSON boundaries;
- integration tests for SQLite, repositories, leasing, and evidence lifecycle;
- adversarial tests for target warnings/continuation, argv, paths, symlinks, output limits, and untrusted content;
- browser acceptance for visible workflows;
- clean-install, doctor, backup, and restore smoke tests for packaging work.

Avoid fixed sleeps in asynchronous tests. Wait for an observable event, transition, process exit, or bounded deadline, and make timeout failures diagnostic.

Initial CI should cover formatting/lint, strict TypeScript typecheck, unit/integration tests, and builds. Add migration compatibility, dependency scanning, secret scanning, SBOM, and release checks when their milestone requires them. Do not keep known-flaky checks as decorative green badges.

## 10. UI evidence

Appearance changes require before/after screenshots. Motion, timing, resize, persistence, responsive transitions, and keyboard interaction changes require a short recording.

Evidence should cover relevant desktop/mobile, light/dark, keyboard, touch, and reduced-motion states. It must come from the actual branch and must not contain secrets or real target data.

## 11. Definition of done

A change is done when:

- agreed behavior exists and non-goals remained out of scope;
- focused verification and required CI pass on the latest revision;
- failure, cancellation, retry, and reverse states are truthful where applicable;
- security/privacy behavior is tested where applicable;
- contracts, behavior, and documentation agree;
- migrations and recovery are explained honestly;
- required visual evidence exists;
- findings are resolved with evidence;
- the owner completes the walkthrough and squash-merges;
- leftover work becomes explicit issues instead of hidden TODOs.

## 12. Documentation ownership

- `README.md`: product purpose, status, and repository map.
- `AGENTS.md`: concise executable agent rules.
- `docs/development/V0.1_PLAN.md`: accepted scope, architecture, milestones, and acceptance.
- this handbook: issue-to-release workflow.
- `docs/architecture/`: accepted ADRs and decision gates.
- `docs/security/`: threat models and durable security policy.
- `docs/ui/`: UI contracts and gallery guidance.
- `CONTRIBUTING.md`: external contributor workflow when the repository approaches public release.
- `SECURITY.md`: reporting and supported-version policy before public release.

Documentation describes shipped behavior in present tense. Roadmap work stays in the plan and issues.

## 13. Bootstrap and repository settings

The bootstrap commit is the only owner-approved direct commit to `main`. It contains governance and repository skeleton, not hidden product features.

After bootstrap:

- enable available ruleset protection;
- require PRs and status checks where supported;
- require resolved conversations;
- prohibit force pushes and deletion of `main`;
- add issue and PR templates;
- verify CI with one deliberately tiny normal PR;
- prohibit further direct commits to `main`.

Any unavailable GitHub protection is documented as a temporary risk with a manual substitute.

## 14. Releases

Before M4, PR and `main` CI artifacts are sufficient.

A nightly channel may begin after an installable M4 slice. It builds only reviewed `main`, publishes nothing when `main` is unchanged, records the exact commit, is marked prerelease, and never writes version bumps back to the repository.

Stable releases are manual and owner-approved. Before public v0.1, verify clean installation, upgrade and migration behavior, consistent backup/restore, control-plane/runner compatibility, doctor output, checksums, SBOM, license inventory, and disclosure documentation.

Never publish, tag, or announce a release based only on an agent report.

## 15. Solo-maintainer rhythm

1. Choose the next smallest useful outcome.
2. Approve one or two Ready issues and required decisions.
3. Assign isolated worktrees within the owner's review capacity.
4. Review completed work before growing the queue.
5. Perform the walkthrough and squash merge.
6. Dogfood current `main` in a dedicated lab.
7. File observations as issues.
8. Re-plan at milestone boundaries.

The objective is understandable decisions and steady progress.
