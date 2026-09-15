# ADR-0001: Target normalization, saved scope, and warnings

Status: accepted

Date: 2026-08-09

Decision gate: [D1](./DECISION_GATES.md#d1-target-normalization-saved-scope-and-warnings)

Issue: [#23](https://github.com/lbgos/stonehush/issues/23)

## Context

M2 introduces engagement targets, immutable saved-scope revisions, and warnings. The control plane needs one canonical identity for each supported target so equivalent spellings do not produce different scope results. Actions also need stable resolution evidence and warning state that cannot drift across retries, redirects, or DNS changes.

Scope is operator context, not authorization. Any target set that an installed action can represent remains runnable. Malformed input and target sets that the action cannot technically execute are errors, not policy denials.

This ADR defines the `d1-v1` profile. The versioned [acceptance fixtures](./fixtures/d1/) are part of the decision and are intended for direct reuse by later contract and domain tests.

## Decision

### Ownership and input classification

The Node.js 24 control plane is the only component that normalizes raw target input. Every canonical target carries `normalizationProfile: "d1-v1"`. Plugins and consumers in other languages receive canonical values and treat them as opaque protocol data.

One target input is at most 4096 UTF-8 bytes. Normalization trims surrounding ASCII whitespace. It rejects an empty result, NUL or other control bytes, and internal whitespace when the selected grammar does not permit it.

Classification order is:

1. an explicit `http` or `https` URL;
2. CIDR;
3. IP address;
4. hostname or domain.

Classification is terminal. Once explicit HTTP(S), CIDR-looking, numeric/IP-looking, or hostname syntax selects a grammar, failure in that grammar does not fall through to another grammar. An explicit unsupported scheme is rejected and is not reinterpreted as a hostname.

Malformed selected syntax uses these stable errors:

- `invalid_url` for malformed explicit HTTP or HTTPS syntax;
- `invalid_ipv6` for IPv6-looking input with invalid IPv6 syntax;
- `invalid_cidr` for CIDR-looking input with an invalid address or prefix.

### Host and address normalization

IPv4 is exactly four ASCII decimal components from 0 through 255. A component has no leading zero unless it is `0`. Signs, alternate component counts, internal whitespace, hexadecimal, and octal-looking spellings are invalid. Canonical output is the four decimal components without leading zeroes.

IPv6 output follows RFC 5952: lowercase hexadecimal, the longest eligible zero run compressed, and no unnecessary leading zeroes. Any address in `::ffff:0:0/96`, regardless of input spelling, becomes the canonical IPv4 identity. IPv4-mapped IPv6 CIDR input is invalid because mapped endpoints share IPv4 identity and scope.

A bare IPv6 zone uses one literal percent separator. A URL zone uses RFC 6874 `%25`: URL authority preprocessing recognizes the first `%25` as the separator, preserves every following character as the ZoneID, and does not percent-decode the ZoneID again. Therefore, characters `25` immediately after the separator are ordinary ZoneID characters; for example, `%2525Eth0` carries the zone `25Eth0`. `d1-v1` accepts a zone only on a link-local address in `fe80::/10`; the zone is 1 through 15 ASCII unreserved characters from `[A-Za-z0-9._~-]`. URL authority preprocessing extracts the zone before the pinned Node.js 24 WHATWG URL parser runs, and canonical serialization restores `%25` followed by the zone. The zone is a separate, case-sensitive value. Exact address matching includes it. CIDR membership uses address bits and ignores it, while action snapshots retain it.

Hostname processing uses UTS #46 non-transitional mapping with STD3 rules and Unicode 15.1 tables. Mapping occurs before label validation. The normalizer removes exactly one final ASCII dot, rejects an empty remaining label, converts to IDNA ASCII, lowercases it, and enforces 63 bytes per label and 253 bytes total. Single-label lab hostnames are valid. Empty or invalid IDNA output, underscores, wildcards, invalid label boundaries, and ambiguous numeric hosts are rejected. Representative profile results include `BÜCHER.Example.` to `xn--bcher-kva.example` and `faß.test` to `xn--fa-hia.test`.

CIDR canonicalization validates the prefix, masks host bits to the network address, and records whether masking changed the supplied address.

### URL normalization and origin identity

Only HTTP and HTTPS URLs are supported. Any userinfo is invalid. Any fragment delimiter is invalid, including an empty `#`. Except for the zone preprocessing described above, parsing and serialization use the WHATWG basic URL parser and serializer from the pinned Node.js 24 control plane.

The action target preserves the serializer-produced path and query. An empty path becomes `/`. Normalized URL serialization omits default port 80 for HTTP and 443 for HTTPS, while a non-default port remains. Canonical origin identity is always serialized as `scheme://host:effectivePort`, including the effective default port when URL serialization omits it. Path and query do not widen or narrow scope.

### Saved-scope revisions and matching

Scope revisions are immutable. `scopeRevisionId: null` means that an engagement has no active saved scope and disables outside-scope warnings. An active revision with zero rules is different: every destination is outside that saved scope.

A revision may contain:

- an exact IP rule, including a zone for an exact scoped IPv6 address;
- an IPv4 or IPv6 CIDR rule;
- a hostname or domain rule with an explicit `includeSubdomains` value;
- a URL-origin rule;
- optional port restrictions on a host predicate.

A domain rule always includes its apex. When `includeSubdomains` is true, it matches descendants only at a label boundary. It never matches a sibling or a suffix embedded in another label.

Port restrictions are inclusive ranges from 1 through 65535. They are sorted and overlapping or adjacent ranges are merged. Matching is the host predicate AND the declared action ports. Every declared action port must be covered. An action with unspecified ports does not match a port-restricted rule because its destination ports are not bounded. URL comparisons use the effective default port even when it was omitted from serialized input.

A hostname rule covers the A and AAAA answers derived for that hostname during the same action. It does not add those addresses to saved scope for another hostname or a future action. Shared and CDN addresses never transfer hostname scope membership. Every redirect origin is evaluated independently by scheme, canonical hostname, and effective port.

### Resolution and immutable action snapshots

The control plane resolves a hostname while planning an action that requires concrete addresses. A resolution snapshot records:

- canonical query name;
- CNAME chain when the resolver supplies it;
- resolver mode;
- each A or AAAA answer and address family;
- TTL when available;
- resolution timestamp.

Failure to obtain an address required by the selected action enters `capability_error` before queueing. It is not an outside-scope warning and cannot be overridden by Continue because there is no executable destination set.

Before queueing, the action freezes canonical input targets, concrete destinations, typed options, active scope revision, resolution results, and warning state into an immutable target/options/resolution/scope snapshot. The acknowledgment binding uses `actionId` plus the snapshot hash. Plugins receive this snapshot.

The control plane is the only component that derives that hash. The versioned server-only profile is `action-snapshot-json-v1`. It binds exactly these six immutable snapshot fields and no other snapshot identity or projection fields:

- `actionId`
- `canonicalTargets`
- `typedOptions`
- `resolutionSnapshots`
- `scopeRevisionId`
- `warningState`

`snapshotId`, `version`, `binding`, `concreteDestinations`, `normalizationProfile`, and `orchestrationProfile` are stored with the snapshot and are not hashed. The versioned envelope adds `canonicalizationProfile: "action-snapshot-json-v1"` so a later profile cannot silently collide. Serialization reuses the accepted JSON spelling rules: objects sort keys by ECMAScript UTF-16 code-unit order; arrays preserve order; strings and finite numbers use ECMAScript JSON spelling, including `-0` as `0`; explicit `null` remains present, including `scopeRevisionId: null` and `warningState.acknowledgment: null`. UUIDs and Unicode are not rewritten. Undefined or non-JSON values, sparse arrays, non-plain objects, accessors, symbol keys, cycles, non-finite numbers, unpaired surrogates, depth over 32 containers, and canonical UTF-8 output over 1 MiB fail closed before a binding is issued. SHA-256 is lowercase hexadecimal with prefix `sha256:`. Exact vectors are pinned in the D1 snapshot-canonicalization fixture. This profile is not `command-json-v1` and does not hash actor, route, or command envelopes.

HTTP-capable first-party actions connect only to the frozen A and AAAA set for the current origin while preserving that origin's canonical Host header and SNI name. DNS changes cannot replace the frozen set silently. Each redirect origin gets its own frozen action-scoped resolution set.

Each redirect hop records source URL, raw `Location` value, canonical destination, scheme, canonical host, effective port, and the resolved address actually used. Later destinations append evidence and covered-destination records; they never mutate the immutable action snapshot.

A retry creates a new run attempt under the same action and reuses its targets, options, resolutions, scope snapshot, and warning acknowledgment. Editing a target or options, or refreshing resolution, creates a new action with a new snapshot and warning budget.

### Large target sets and representability

The control plane estimates concrete target cardinality after canonical host-identity deduplication and excludes the number of ports. It uses integer arithmetic and stops counting at the sentinel value 4097. An estimate above 4096 contributes `large_target_set` to the action's warning reasons.

The threshold is not a hard policy cap. Compact CIDR or range representations remain compact when the installed action supports them. Otherwise expansion is streamed. The estimator never expands a huge IPv6 range merely to decide whether to warn.

If the installed action cannot technically represent or expand the requested set, the action enters `capability_error` before queueing. Continue cannot override this because no executable target set exists. This error is distinct from saved scope, warning policy, and risk labels.

### One-warning state semantics

An action has a lifetime budget of at most one warning interaction. Known pre-run reasons, including outside-scope and large-target reasons, are combined into one warning. Risk tier text may later contribute to this same interaction, but risk tiers do not block execution.

Continue is the primary path for every representable action. Its behavior is:

- `Continue` records source `operator_continue` against the exact action and immutable snapshot hash, then queues or resumes without changing saved scope.
- Before queueing, `Add to scope & run` explicitly commits a new immutable scope revision, rechecks the action exactly once, updates the same reason set, binds source `add_scope_and_run` to the post-recheck snapshot, and queues without a second prompt. The option is not required for execution. A late execution warning offers Continue and Cancel; it cannot rewrite the already queued snapshot or its saved-scope context.
- Engagement auto-continue records the same warning facts with source `engagement_policy` and queues or resumes without UI interruption.

If no warning has been acknowledged and execution first discovers an outside-scope DNS or redirect destination, the destination and reason are durably recorded before any connection to it and the action transitions from `active` to `active_paused_for_warning`. The current Run remains `running` under its lease while the adapter cooperatively waits before connecting. Closing the card, losing the UI, or waiting changes no warning or lifecycle state. There is no warning timeout, and wall-duration accounting is suspended during this operator wait. Explicit Continue records the acknowledgment and resumes; explicit Cancel requests process cleanup and becomes terminal only after the runner reports its result.

The planning state remains `paused_for_warning`; `active_paused_for_warning` is deliberately distinct so queue ownership, the immutable `queuedSnapshotVersion`, the live Run, and cleanup consequences remain truthful. D2 owns the exact Action/Run transitions, fencing, heartbeat, resume-directive, cancellation, and lease-expiry mechanics.

If engagement auto-continue is active, a late condition records `engagement_policy` and continues without pausing. Once any acknowledgment exists, every later reason or destination appends to its warning record and evidence without another prompt or pause. The acknowledgment covers the full action across retry run attempts.

### Durable warning record

The minimum durable warning record contains:

- action ID;
- target snapshot ID or digest and the immutable target/options/resolution/scope snapshot hash;
- scope revision ID, or `null` when none is active;
- normalized reason codes and the concrete additions known at acknowledgment time;
- acknowledgment source: `operator_continue`, `add_scope_and_run`, or `engagement_policy`;
- acknowledgment timestamp;
- later discovered normalized destinations and reasons covered by the acknowledgment.

The warning record is operational evidence, not an authorization attestation. D1 introduces no accounts, second approval flow, timeout approval, or hidden deny policy.

## Alternatives considered

### Treat saved scope as an allow list

Rejected because it would turn context into authorization and break the product requirement that every representable action remains runnable.

### Prompt for every late DNS answer or redirect

Rejected because repeated prompts slow the operator and do not improve the evidence record. One acknowledgment plus append-only destination facts preserves both speed and auditability.

### Normalize independently in each plugin

Rejected because IDNA, URL, and address implementations can disagree across languages. Central normalization with a versioned profile gives plugins one opaque contract.

### Refresh DNS automatically on retry

Rejected because the retry would no longer reproduce the same intended action. Explicit refresh creates a new action and a new evidence snapshot.

### Expand all target ranges before planning

Rejected because large IPv6 ranges make eager expansion unsafe or impossible. Saturated counting, compact representations, and streaming expansion preserve truthful capability boundaries.

## Consequences

Equivalent target spellings produce one canonical identity under a named profile. Saved-scope evaluation, DNS evidence, redirects, retries, and warnings have deterministic inputs. Operators receive at most one warning interaction and can always Continue when the target set is executable.

The control plane must pin Unicode 15.1 data and Node.js 24 URL behavior for `d1-v1`. A future change to those semantics requires a new normalization profile and migration or compatibility decision. Snapshots and warning records carry more provenance, but that cost prevents silent target drift.

This ADR defines behavior only. It does not add runtime normalization, domain packages, persistence, API routes, UI, DNS calls, plugins, or runner behavior.

## Safety and privacy

Raw target, plugin, model, DNS, redirect, and evidence fields remain untrusted input. Later implementations must validate before storage or display and must not place secrets in target snapshots or warning records. Tests and fixtures use reserved documentation addresses and synthetic names only.

Warnings never substitute for technical validation. Malformed input and capability errors stop because the system cannot construct an executable action. Outside-scope, size, and risk facts warn but never remove Continue from a representable action.

## M2 follow-up map

Implement D1 through separate bounded issues in this order:

1. **Target contracts and pure normalization:** add versioned canonical target contracts and implement `d1-v1` parsing against normalization fixtures.
2. **Saved-scope comparison:** implement immutable rule normalization, host and port intersection, cardinality estimation, and scope comparison against scope fixtures.
3. **Action snapshots and warning state:** implement pure snapshot hashing and one-warning transitions against resolution and warning-flow fixtures.
4. **Engagement and action persistence:** persist immutable scope revisions, snapshots, acknowledgments, and covered destinations with repository tests.
5. **M2 API surface:** expose engagement, scope revision, action planning, Continue, add-scope, auto-continue, cancel, and retry contracts with idempotency behavior deferred to D2 where required.
6. **Minimal M2 target UI:** provide target entry, scope context, the one-warning card, Continue as the primary action, optional add-scope, Cancel, and auto-continue preference with visual acceptance evidence.

Each issue consumes the ADR and fixtures without redefining normalization or warning policy. Runtime DNS pinning and redirect execution belong to their dependent HTTP and runner milestones, while their contracts and snapshots originate in M2.

## Acceptance evidence

- [Normalization fixtures](./fixtures/d1/normalization.json) cover valid and adversarial IPv4, IPv6, mapped IPv6, zones, IDNA, trailing dots, CIDR, and URL behavior.
- [Scope fixtures](./fixtures/d1/scope-comparison.json) cover null and empty revisions, label boundaries, origins, port restrictions, shared addresses, and saturated cardinality.
- [Resolution and snapshot fixtures](./fixtures/d1/resolution-snapshot.json) cover resolution evidence, pinning, retry, refresh, redirect origins, and capability errors.
- [Snapshot canonicalization fixtures](./fixtures/d1/snapshot-canonicalization.json) pin `action-snapshot-json-v1` field coverage, explicit nulls, array order, and SHA-256 vectors.
- [Warning-flow fixtures](./fixtures/d1/warning-flow.json) cover combined reasons, Continue, add-scope recheck, auto-continue, late discovery, UI loss, Cancel, and covered destinations.
- `node --test scripts/check-docs.test.mjs` validates fixture shape, versions, unique case IDs, required outcomes, and forbidden secret or non-reserved target content.
- `pnpm check` runs the validator through the repository documentation check.
