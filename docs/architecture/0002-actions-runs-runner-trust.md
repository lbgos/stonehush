# ADR-0002: Actions, runs, concurrency, and runner trust

Status: accepted

Date: 2026-08-09

Decision gate: [D2](./DECISION_GATES.md#d2-actions-runs-concurrency-and-runner-trust)

Issue: [#33](https://github.com/lbgos/stonehush/issues/33)

## Context

M3 connects the control plane to an unprivileged host process that can execute local tools. The system must survive retries, duplicate requests, concurrent browser commands, process crashes, runner restarts, and stale network traffic without rewriting a terminal result or accepting output from an obsolete executor.

D1 already makes target warnings informational and freezes the target context. This decision does not add another approval boundary. It defines the `d2-v1` orchestration profile and the runner control protocol `runner-control-v1`. The versioned [acceptance fixtures](./fixtures/d2/) are executable decision records for later contract, database, API, and runner tests.

## Decision

### Ownership and durable records

The control plane is the sole owner of Action and Run state, planning snapshot versions, idempotency records, leases, ordered events, and terminal results. The runner never opens SQLite and cannot assign IDs, fencing tokens, revisions, or terminal state independently.

An Action is an operator intent. Its planning snapshots are numbered positive integers and append-only. Creating the action writes version 1. `Add to scope & run` commits a new immutable scope revision and planning snapshot version in one transaction, then rechecks once. It never updates or deletes version 1. Only the snapshot version that first enters `queued` is `queuedSnapshotVersion`; it is immutable thereafter. Continue and auto-continue queue that version. A capability error has no queued version.

A Run is one attempt. Its positive `attempt` is allocated under its Action in the queue transaction. Retry is permitted only after `failed` or `cancelled`, creates the next Run, reuses the Action's `queuedSnapshotVersion`, snapshot digest, and warning acknowledgment, and does not mutate the prior Run or its evidence. Successful Actions are not retried in v0.1; editing targets, options, or resolution creates a new Action.

Action is a revision-checked aggregate with these valid edges:

| From | To | Cause |
| --- | --- | --- |
| `planning` | `paused_for_warning` | representable plan has unacknowledged reasons |
| `planning` | `queued` | no warning or auto-continue |
| `planning` | `capability_error` | no executable representation |
| `planning` | `cancelled` | operator cancels planning |
| `paused_for_warning` | `planning` | add-scope transaction appends and rechecks a snapshot |
| `paused_for_warning` | `queued` | Continue or auto-continue |
| `paused_for_warning` | `cancelled` | operator cancels |
| `queued` | `active` | its Run obtains a lease |
| `queued` | `cancelled` | queued Run is cancelled |
| `queued` | `failed` | fencing token cannot be incremented |
| `active` | `queued` | an unstarted leased Run expires and returns to the queue |
| `active` | `active_paused_for_warning` | current fenced Run reports a first unacknowledged late destination before connecting |
| `active` | `succeeded`, `failed`, or `cancelled` | current Run reaches terminal state |
| `active_paused_for_warning` | `active` | Continue durably acknowledges the exact pending context and creates a resume directive |
| `active_paused_for_warning` | `failed` or `cancelled` | current Run reaches terminal state after runner loss or verified cancellation cleanup |
| `failed`, `cancelled` | `queued` | explicit retry creates a Run |

`succeeded` and `capability_error` have no outgoing edge. Every other pair, including a same-state transition request, is `invalid_action_transition`. An accepted event may append evidence or update a projection without changing lifecycle state; that is not a same-state transition.

Run has these valid edges:

| From | To | Cause |
| --- | --- | --- |
| `queued` | `leased` | atomic lease acquisition |
| `queued` | `cancelled` | cancellation before lease |
| `queued` | `failed` | fencing token is exhausted before lease creation |
| `leased` | `queued` | lease expires before `started` |
| `leased` | `running` | fenced `started` event, committed before spawn |
| `leased` | `cancel_requested` | cancellation after lease |
| `leased` | `failed` | preparation or spawn failure |
| `running` | `cancel_requested` | cancellation or duration deadline |
| `running` | `succeeded`, `failed` | fenced completion |
| `running` | `failed` | lease expires or control plane declares runner loss |
| `cancel_requested` | `cancelled` | cleanup verified and fenced completion accepted |
| `cancel_requested` | `failed` | cleanup cannot be verified or the lease expires |

`succeeded`, `failed`, and `cancelled` are terminal and have no outgoing edges. Every other pair is `invalid_run_transition`. A compare-and-set terminal transaction wins once; duplicate identical completion replays the winner, while a different completion returns `run_already_terminal`. Action aggregate updates and its event append occur in that same transaction.

An action contract that can discover a new DNS or redirect destination during execution uses a cooperative connection gate. Before connecting, its runner adapter submits a fenced, sequenced `late_destination_pending` event containing the exact normalized destination, resolution, reason, queued snapshot version, and snapshot digest. The control plane transaction appends the pending fact and event evidence, then either records an existing/automatic acknowledgment and returns `continue`, or moves Action `active -> active_paused_for_warning` and returns `pause`. The Run stays `running`; the adapter makes no connection to the pending destination, continues heartbeats and cancel polling, and suspends wall-duration accounting while paused. Generic child output cannot synthesize this trusted control event.

Continue against `active_paused_for_warning` binds one acknowledgment to the Action, immutable queued snapshot, and exact pending event context, moves the Action back to `active`, and creates one durable fenced resume directive. The runner deduplicates directives by ID and acknowledges delivery; polling returns the directive until that acknowledgment. The adapter connects only after observing it. Engagement auto-continue performs the acknowledgment and returns `continue` in the original event transaction, so no pause occurs. If any acknowledgment already exists, later destinations append to its covered context and evidence without a pause. None of these paths changes saved scope or the queued snapshot.

Cancel while `active_paused_for_warning` moves the Run `running -> cancel_requested` but leaves the Action paused until cleanup is truthful. Verified cleanup completes Run and Action as `cancelled`; cleanup failure or lease expiry completes them as `failed` with the applicable reason and preserves the pending evidence. A paused lease still requires heartbeats. An expired or superseded fence, wrong sequence, or non-running Run cannot append a pending destination, pause the Action, acknowledge a warning, or create a directive. A fresh Continue after cancellation wins returns `invalid_run_transition`. An exact stored Continue replay returns only its stored response and never reapplies a directive or supersedes the later cancellation.

The runner commits `started` before spawning. Before launch it fsyncs a journal intent containing the Linux boot ID, Run and lease IDs, fence, a random 128-bit Run marker, and the unique delegated cgroup path. Immediately after spawn it adds the child PID, process-group ID, `/proc/<pid>/stat` start-time field, executable digest, and argv digest and fsyncs again. A spawn failure completes the already-running Run as `failed`. This narrow ordering prevents an expired `leased` Run from knowingly representing a started process; service-level `KillMode=control-group` cleanup covers a crash between spawn and the second journal sync.

### Idempotency and optimistic concurrency

Every command key is 22 through 128 printable ASCII characters and is scoped to authenticated actor identity, route, and operation. The control plane stores the key, canonical request SHA-256 digest, response status/body, and created time in the same transaction as the mutation. Records are retained for 30 days and never evicted while the referenced nonterminal Action or Run exists.

The caller generates a fresh cryptographically random key with at least 128 bits for each intended mutation and reuses only that key when retrying the same mutation. It never derives a key from a Run ID, fence, event sequence, timestamp, or another resetting counter. The runner persists the key and canonical request digest in its fsynced outbox before transmission and removes them only after a definitive response; an operator client retains them with its pending command until resolution. The route scope is the concrete canonical route including resource IDs. A random collision fails closed as `idempotency_conflict` rather than applying another request.

The canonical request includes all semantic path, query, and validated body fields, explicit `null`, the expected revision, and authenticated actor ID; it excludes transport headers and object insertion order. Same scope, key, and digest replays the stored response without a new event. Same key with another digest returns HTTP 409 `idempotency_conflict`. An unfinished competing transaction is serialized by SQLite and then follows the same rule.

Operator commands use canonicalization profile `command-json-v1`. Until browser authentication lands, the loopback-only server assigns actor `local-operator-v1`; callers cannot supply it. The versioned envelope contains that actor, the concrete route, operation, schema-parsed path and query objects, and schema-parsed body. Objects sort keys by ECMAScript UTF-16 code-unit order; arrays preserve order; strings and finite numbers use ECMAScript JSON spelling, including `-0` as `0`; explicit `null` remains present. UUIDs and Unicode are not rewritten or normalized. Undefined or non-JSON values, sparse arrays, non-plain objects, accessors, symbol keys, cycles, non-finite numbers, unpaired surrogates, depth over 32 containers, and canonical UTF-8 output over 1 MiB fail closed before mutation. SHA-256 is lowercase hexadecimal with prefix `sha256:`. The exact vectors are pinned in the D2 canonical-request fixture.

Validation order is security-significant. The endpoint authenticates the presented credential and route first, parses the bounded key and fields needed to compute the canonical request digest, then looks up the stored `(actor, route, operation, key)` tuple. An exact stored digest returns its stored result before current revision, lifecycle, lease-expiry, fence, or sequence validation, even when the original mutation made the Run terminal or its lease later expired or was superseded. A stored tuple with another digest returns `idempotency_conflict` at this point. Only an absent tuple proceeds through full schema, authorization, current revision, current unexpired lease/fence, and sequence checks before mutating and storing a result atomically. Revoked or otherwise invalid credentials cannot replay because authentication always comes first.

| Mutation | Required identity and compare condition |
| --- | --- |
| create/plan Action | operator key; active scope revision and canonical planning input are in the digest |
| Continue | operator key; Action `expectedRevision`, snapshot version and digest, plus pending event ID and current Run state `running` when actively paused |
| Add to scope & run | operator key; Action and Engagement expected revisions plus proposed rules |
| retry | operator key; Action expected revision and terminal Run ID |
| cancel | operator key; Action and current Run expected revisions |
| runner event batch | runner key plus lease ID, fence, first sequence, and ordered event digests |
| completion | runner key plus lease ID, fence, next event sequence, terminal kind, and bounded metadata |

Runner counters occupy separate domains. Heartbeat uses a positive `heartbeatSequence` scoped to the lease: an identical sequence replays the stored expiry, a changed body conflicts, and a lower sequence is stale. Event batches and completion share one positive contiguous `eventSequence` scoped to the fence; completion consumes the next sequence and receives an `eventId` like any other accepted event. Idempotency keys are random and independent of both counters. Server-to-runner directives use opaque directive IDs and explicit acknowledgment, not either client counter. Mutable Engagement, Action, Run, runner identity, registry, and settings commands require an integer `expectedRevision`. A mismatch returns 409 `revision_conflict` with only resource type, ID, and current revision. Append-only events and snapshots do not expose update operations.

SQLite uses WAL, `foreign_keys=ON`, `synchronous=FULL`, and `busy_timeout=5000`. Each connection asserts those pragmas. One control-plane process owns all writes in v0.1; HTTP handlers and runner endpoints submit short write transactions to its bounded queue. Lease acquisition, sequence allocation, idempotency insert, terminal compare-and-set, and multi-resource add-scope use `BEGIN IMMEDIATE`. Transactions perform no DNS, process, filesystem, SSE socket, or plugin I/O. After 5 seconds, a blocked mutation returns 503 `storage_busy`; clients may replay the same key. Compose replicas and direct runner database access are unsupported.

### Runner enrollment, secret lifecycle, and API boundary

v0.1 permits one enabled local runner identity. The owner starts enrollment from the loopback UI, verifies a displayed runner name and SHA-256 public installation fingerprint, and explicitly confirms it. Confirmation creates a 32-byte cryptographically random bearer secret, encoded base64url and shown exactly once. The credential format has a nonsecret runner ID selector and the secret. Enrollment challenges expire after 10 minutes and are one-use.

The server stores a random 32-byte salt and a 32-byte `scrypt` verifier (`N=16384`, `r=8`, `p=1`), never the secret. The runner credential file is owned by its dedicated service user, mode `0600`, outside the working directory. Authentication comparisons are constant-time. Request logs contain only runner ID and a credential fingerprint consisting of the first 12 hexadecimal characters of SHA-256 over the secret; authorization headers and secret values are removed before structured logging.

Rotation requires owner confirmation and presents a new secret once. The old secret remains valid for a 60-second handover, restricted to finishing or cancelling already leased work; it cannot obtain a new lease. It is then revoked automatically. Explicit revocation immediately fences all leases, marks each active Run for cancellation, and denies every runner endpoint. The runner treats any authentication rejection on its control channel as a mandatory cancel-all signal, performs process-group cleanup, and requires fresh enrollment before leasing again. A lost credential is not recoverable or redisplayed: the owner revokes the identity, removes the local file, and enrolls again. The database, logs, events, fixtures, exports, and PR text never contain plaintext runner credentials.

Runner authentication is accepted only on `/api/v1/runner/*`. Its capabilities are handshake, lease, heartbeat/cancel polling, ordered event append, bounded staging transfer defined by D3, and completion. It cannot read or mutate engagements, scope, findings, settings, browser sessions, other runners, arbitrary evidence, or reports. Operator/browser credentials are rejected on runner routes and runner credentials are rejected elsewhere.

### Handshake and compatibility

Every service start handshakes before leasing with:

- exact protocol `runner-control-v1`;
- runner build version and installation fingerprint;
- Linux architecture and kernel facts;
- a fresh random session ID;
- supported event schema versions;
- detected supervision capabilities;
- the digest and immutable version IDs of executable registry entries;
- a bounded list of abandoned-journal reports containing only Run/lease/fence/session identity, cleanup disposition, and fixed reason codes.

The server supports exactly `runner-control-v1` during v0.1. A mismatch returns 426 `runner_protocol_unsupported`, the supported protocol list, and no lease. An unknown event schema returns 422 `event_schema_unsupported`. Build versions are recorded but not used as an implicit compatibility promise. Missing action-required capabilities return `runner_capability_unavailable` before lease. A registry digest change requires a new handshake; a lease pins the accepted session, executable version, and capability set.

### Leases, fencing, recovery, and ordered events

A lease lasts 30 seconds. The runner heartbeats every 10 seconds. Only control-plane UTC time determines expiry; an accepted heartbeat sets expiry to server-now plus 30 seconds. Lease acquisition is a `BEGIN IMMEDIATE` oldest-queued compare-and-set, respects the configured runner concurrency (default 2, range 1 through 32), creates a random lease ID, and increments that Run's signed 64-bit fencing token. The first fence is 1. A token overflow permanently fails the Run with `fencing_exhausted`.

Every new runner event or completion supplies authenticated runner ID, pinned session ID, Run ID, lease ID, fence, and the applicable event sequence. After the idempotency lookup described above, a new mutation is accepted only if all values match the current unexpired lease. A superseded fence returns 409 `stale_fence`; an expired lease returns 409 `lease_expired`; another identity/session returns 403 `lease_owner_mismatch`. None append an event or terminal state. Exact stored replays return their original result without reapplying those now-stale lease checks.

The runner also self-fences work when the control channel is unavailable. Each accepted lease or heartbeat response carries the 30-second duration; the runner anchors a conservative expiry to the monotonic request-send instant, never to runner wall time. If renewal is not accepted, it begins the normal 5-second TERM and 2-second KILL cleanup seven seconds before that local deadline and admits no new connection or child work. By the deadline it requires that no descendant remains, quarantining and marking itself unhealthy if verification fails. Any `lease_expired`, `stale_fence`, or `lease_owner_mismatch` response for current work triggers the same immediate cancel-all for that Run. This may stop early during a partition, but it prevents an alive isolated runner from continuing after its authority can have expired.

If a lease expires in `leased`, the control plane appends `lease_expired`, moves the Run back to `queued`, and a later lease receives a new ID and higher fence. If it expires in `running`, the control plane terminally fails the Run as `runner_lost`; it never automatically repeats an action that may already have affected a target. Expiry in `cancel_requested` fails it as `runner_lost_during_cancel`. Operator retry is explicit.

Leases, fences, event sequences, terminal state, and idempotency records survive control-plane restart. A restarted control plane accepts a still-current lease. A restarted runner must handshake with a new session, inspect every journal, and report abandoned work; the server fences it and records `runner_restarted`. It cannot adopt the old session. Only an unstarted expired lease returns to the queue. Startup does not infer success from a missing process.

Restart cleanup never trusts a numeric PID or process-group ID alone. The journal's boot ID must equal `/proc/sys/kernel/random/boot_id`; the live process start-time field must equal the journalled value; the process must be in the exact journalled cgroup; and that unique cgroup basename must contain the journalled 128-bit Run marker. Only after all four checks may the runner signal the cgroup/process group. A boot mismatch marks the journal stale and removes it without signalling. A missing process or identity, start-time, cgroup, or marker mismatch never signals the numeric ID, records `restart_identity_mismatch`, quarantines the journal and working directory for owner inspection, and reports the Run failed. This prevents reboot-stale journals and PID/PGID reuse from killing unrelated processes without relying on unsupported custom files in cgroupfs.

Runner event sequences begin at 1 for each fence and must be contiguous across event batches and completion. An accepted event, including completion, gets a persistent SQLite integer `eventId` in the same transaction as any projection, observation uniqueness record, or terminal transition. Replaying the same fence, sequence, and canonical event digest returns its prior event ID. A different digest conflicts with `event_replay_conflict`, except that a different completion after the Run became terminal returns `run_already_terminal`; a gap returns `event_sequence_gap`. D3 will define artifact publication, but its eventual identity must be unique by Run, fence, sequence, and declared artifact slot so replay cannot duplicate it.

SSE IDs are decimal `eventId` values, strictly increasing within a stream query. Clients resume with `Last-Event-ID`; the server returns events with larger IDs and never synthesizes a duplicate. Delivery rows are retained for 7 days and at least the newest 100,000 events per engagement; durable Run terminal data is not deleted with them. A cursor older than the retained lower bound receives HTTP 410 `sse_cursor_expired` with `earliestEventId` and a versioned snapshot URL. A future cursor returns 409 `sse_cursor_ahead`. Reconnect without a cursor starts after the endpoint's current snapshot watermark.

### Executable registry and process creation

The owner-managed installed-executable registry stores an immutable version record containing stable ID, absolute configured path, resolved real path, device/inode, SHA-256 digest, observed version string, inspection timestamp, and supported typed actions. Registration rejects relative paths, missing paths, non-regular files, symlinks, and files not executable by the runner user. The executable and every parent directory through the filesystem root must be owned by UID 0 and must not be group- or world-writable. D5 may later accept an owner-selected source by copying it into a root-owned managed registry with these same properties; D2 does not execute a mutable user-owned source. Inspection is argv-only, limited to 5 seconds and 64 KiB combined output. Any path, inode, digest, owner, or mode change disables that version until explicit re-registration. D5 later defines plugin installation and provenance; D2 does not allow community installation.

A lease names a registry version and a typed action contract. Immediately before launch, the runner walks parents with no-follow descriptor operations, opens the root-owned executable with `O_NOFOLLOW`, and rechecks type, owner, mode, device/inode, digest, and execute access through that descriptor. It keeps the verified descriptor open and the native supervisor launches it with Linux `execveat(fd, "", argv, env, AT_EMPTY_PATH)`; it never resolves the path again. A same-inode write is denied by ownership/mode and a post-check path replacement cannot change the opened object. Any verification failure closes the descriptor, disables the registry version, and spawns nothing. It invokes an explicit executable and argv array with no shell, command string, interpolation, `eval`, or user-selectable wrapper. Contracts contain no raw command or raw flags field. Empty arguments and metacharacters remain single literal argv elements.

The runner inherits no ambient environment. It sets only `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TZ=UTC`, `PATH=/usr/bin:/bin`, and a generated `TMPDIR` inside the Run directory, plus registry-declared nonsecret variables whose names and values pass typed validation. `LD_PRELOAD`, `LD_LIBRARY_PATH`, language startup variables, proxy variables, and any undeclared name are rejected. Future secret injection requires a separate decision and must not enter snapshots or logs.

Each attempt receives a newly created mode `0700` directory under the configured runner root, owned by the dedicated runner user. The name is control-plane generated from opaque IDs. Every component is opened without following symlinks and verified beneath the root; caller paths, `..`, absolute child paths, symlinks, and hardlinked writable inputs are rejected. The process cwd is that directory. Cleanup occurs only after terminal acknowledgment and D3 staging disposition; ambiguous cleanup quarantines the directory and marks runner health degraded.

The production service uses a dedicated unprivileged user, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `RestrictSUIDSGID=yes`, and `KillMode=control-group`. It receives no sudo rule, ambient capability, Docker socket, or raw-socket capability. Required writable roots are explicit. Network access remains available because assessment tools require it.

### Cancellation, limits, output, and redaction

Every child starts in a new process group and, on supported service hosts, a delegated cgroup v2 subtree. Cancel or duration expiry sends `SIGTERM` to the cgroup/process group, waits 5 seconds, sends `SIGKILL`, waits 2 seconds, and verifies that no descendant remains. Exit before escalation is `cancelled` for an operator cancel and `failed` with `duration_exceeded` for a deadline. Failed verification is `process_cleanup_failed`, leaves the directory quarantined, marks runner health unhealthy, and stops admission of new work until cleanup succeeds or the owner intervenes.

The supported-host capability matrix is:

| Control | Ubuntu 22.04/24.04 or Kali, systemd service with delegated cgroup v2 | No delegated cgroup v2 |
| --- | --- | --- |
| wall duration | enforced by runner timer; finite or unlimited | host unsupported; no leases |
| stdout/stderr bytes | enforced by runner; finite only | host unsupported; no leases |
| process-group cancel | required | host unsupported; no leases |
| memory bytes | cgroup `memory.max`; finite or unlimited | host unsupported; no leases |
| process count | cgroup `pids.max`; finite or unlimited | host unsupported; no leases |
| CPU rate | cgroup `cpu.max`; finite or unlimited | host unsupported; no leases |
| file size and open files | finite values unsupported in v0.1; unlimited only | host unsupported; no leases |

Delegated cgroup v2 is an admission requirement because process-group signalling alone cannot prove cleanup after descendants change sessions. Planning and doctor may still return a more specific `resource_control_unsupported` diagnostic for a requested control, but the runner never leases work on a host that fails this admission check.

The concrete limit profile is:

| Control | Default | Allowed finite value | Explicit unlimited value |
| --- | --- | --- | --- |
| wall duration | 30 minutes | 1 second through 24 hours | `null`, supported on every accepted host |
| memory | 512 MiB | 16 MiB through the lesser of 1 TiB and detected host memory | `null`, maps to cgroup `memory.max=max` |
| process count | 64 | 1 through 4096 | `null`, maps to cgroup `pids.max=max` |
| CPU rate | 1000 millicores | 10 through `1000 * detectedLogicalCpuCount` millicores | `null`, maps to cgroup `cpu.max=max` |
| combined retained output | 16 MiB | 64 KiB through 1 GiB | unsupported |
| file size and open files | unlimited | no finite value in v0.1 | `null`, supported |

Limits are frozen in the queued Action snapshot. A detected host bound lower than a configured finite value returns `resource_limit_out_of_range`; a host without the matrix capability returns `resource_control_unsupported`. Operator-selected `null` is distinct from omission and explicitly requests unlimited only where the matrix says it is supported; it is never substituted automatically. Unsupported finite controls fail planning and are never silently ignored. Output cannot be unlimited because the permanent bounded-output invariant takes precedence. A single logical line or frame is limited to 64 KiB. Unacknowledged runner-to-control-plane output is limited to 256 KiB and sent in batches no larger than 32 KiB. At the high-water mark the runner pauses pipe reads; after the retained limit it resumes draining and discards excess so the child cannot deadlock.

Redaction consumes raw bytes before framing, truncation, transport buffering, logging, or D3 staging. Each stdout and stderr stream owns a stateful streaming matcher that preserves partial candidates across arbitrary read boundaries. Exact declared sensitive byte strings use deterministic leftmost-longest byte matching; common ASCII header and flag names are case-insensitive. After a common credential prefix matches, the matcher preserves the prefix, emits `[REDACTED]`, and discards only the value. For an unquoted value, the first ASCII space, tab, CR, LF, or NUL terminates the value and is emitted byte-exact; CRLF therefore preserves both bytes. Quoted forms preserve both quote bytes and replace only their contents. EOF terminates an unquoted or unterminated quoted value safely: the marker remains, no discarded bytes are restored, and a missing closing quote remains missing. A field longer than 64 KiB is still discarded and records `redaction_field_oversize` once. Exact configured match values are limited to 64 KiB, and the matcher withholds at most the longest such value or fixed prefix. It flushes a nonmatching final partial candidate verbatim at EOF. Nonmatching bytes, including invalid UTF-8, remain byte-exact. A complete final frame is redacted even without a newline. Chunking the same byte stream at any boundary produces identical output.

After redaction, raw stdout and stderr are framed deterministically. A logical line over 64 KiB is split at exact 64 KiB byte boundaries into continuation frames; the final fragment carries the line terminator when present. No byte is dropped or treated as a failure merely because a line is long, while the combined retained-output bound still applies. Structured runner-control events are not raw lines. An encoded frame over 64 KiB is rejected before append and terminally fails the Run with `event_frame_too_large`, preserving previously accepted partial evidence.

Truncation runs on the redacted byte stream, so a secret crossing a retention boundary can never leave a retained prefix. Metadata per stream records raw `inputBytesSeen`, `redactedBytesProduced`, `bytesRetained`, `bytesDropped`, `firstDroppedRedactedOffset`, and `truncated=true`; `bytesDropped` is `redactedBytesProduced - bytesRetained`. It does not turn a successful tool exit into failure, and partial evidence remains labelled. Runner-side structured metadata is bounded independently. Invalid UTF-8 is preserved as bytes for D3 and rendered with replacement only in text views.

Registry-declared sensitive argv positions and exact runtime secret values are loaded into that matcher before spawn. Common credential headers and `--password`, `--token`, `--api-key`, and equivalent `name=value` forms are also redacted. Raw unredacted output is not published. IDs, paths, errors, truncation counters, and digests are logged only through fixed structured fields. Untrusted plugin output never becomes a log field name. D3 will decide immutable artifact publication, not whether plaintext credentials may be retained.

### Unprivileged Nmap boundary

M4's initial Nmap action is T1 and uses TCP connect scan only. Its typed options are canonical targets, optional validated ports/ranges, `serviceDetection` boolean, timing template `T0` through `T5`, `skipHostDiscovery` boolean, version intensity 0 through 9, maximum retries 0 through 10, and a bounded duration. The adapter deterministically emits `-sT`, optional `-sV`, `-Tn`, `-Pn`, `--version-intensity`, `--max-retries`, generated `-p` and `-oX` values, then canonical targets. The control plane owns the XML path.

There is no raw flags, raw argv, script, data-file, privileged scan, source spoofing, packet trace, or arbitrary output-path field. `-sS`, OS detection, NSE, raw sockets, Linux capabilities, sudo, and setuid Nmap are unavailable in the v0.1 baseline and return typed `nmap_capability_unsupported` when requested by a future contract. Nmap runs as the dedicated user. Targets and informational warnings remain governed by D1; this boundary prevents command and host-privilege expansion, not operator-selected representable targets.

## Alternatives considered

### Exactly-once external execution

Rejected because a process can affect a target before either side records success. Fencing gives exactly-once durable acceptance, while a running lease loss fails truthfully and requires explicit retry instead of silently repeating work.

### Recover or redisplay runner credentials

Rejected because recoverable plaintext would enlarge the trust boundary. Revocation and re-enrollment are simple for one local runner.

### Pass through arbitrary Nmap flags

Rejected because it would bypass typed capability, argv, path, output, and privilege boundaries. Later typed profiles may add capabilities explicitly.

### Keep output unlimited

Rejected because an untrusted process could exhaust memory, disk, or transport queues. High configurable bounds preserve operator control without making backpressure optional.

### Reassign a Run after a running lease expires

Rejected because the old process may already have produced external effects. Only a lease that never entered `running` is automatically reassigned.

## Consequences

Commands and runner events can be retried safely, terminal outcomes cannot be rewritten, and stale executors cannot append accepted evidence. Explicit retry may require an extra operator action after runner loss, but it avoids pretending that external execution is exactly-once. The one-writer SQLite design is intentionally local and simple; horizontal control-plane replicas remain unsupported.

Some finite resource limits require delegated cgroup v2, while file-size and open-file limits are truthful unsupported capabilities in v0.1. D3 must reuse the event identity and bounded staging boundary when it defines artifact publication. D5 must reuse immutable registry versions and may not introduce shell strings.

## Safety and privacy

D1 Continue remains the primary path for every representable action and no runner decision becomes target authorization. Runner credentials are one-time, nonrecoverable, hashed at rest, route-restricted, and redacted before logging. All process, network, filename, environment, and output values are untrusted. The runner is unprivileged, creates isolated working directories, uses argv-only spawning, bounds output, fences events, and refuses controls it cannot enforce.

Fixtures contain only synthetic IDs, reserved addresses and names, fake executable paths, and redaction markers—not real tokens or credentials.

## Acceptance evidence

- [State fixtures](./fixtures/d2/state-machine.json) pin complete Action and Run transition matrices, append-only planning, one terminal winner, and retry identity.
- [Concurrency fixtures](./fixtures/d2/idempotency-concurrency.json) pin same-key replay, body conflict, revision conflict, and SQLite transaction ownership.
- [Canonical request fixtures](./fixtures/d2/canonical-request.json) pin operator identity, semantic envelopes, serialization, and SHA-256 vectors.
- [Runner identity fixtures](./fixtures/d2/runner-identity.json) pin enrollment, one-time presentation, rotation, revocation, recovery, route separation, and protocol mismatch.
- [Lease and event fixtures](./fixtures/d2/lease-events.json) pin lease-once, heartbeat, expiry, reassignment, fencing, restart recovery, event replay, completion, and SSE cursor behavior.
- [Process fixtures](./fixtures/d2/process-supervision.json) pin argv, environment, cwd, executable identity, cancellation, descendant cleanup, resource capability, output, redaction, and Nmap boundaries.
- `node --test scripts/check-docs.test.mjs` checks the exact fixture file and case-ID set, fingerprints every critical input and exact outcome, and mutation-tests fail-closed behavior.
- Runtime implementation, D3 artifact publication, privileged execution, remote runners, community plugins, accounts, LAN access, and release behavior are outside this decision.
