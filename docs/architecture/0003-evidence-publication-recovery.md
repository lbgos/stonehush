# ADR-0003: Evidence publication, integrity, and recovery

Status: accepted

Date: 2026-08-16

Decision gate: [D3](./DECISION_GATES.md#d3-evidence-durability-privacy-and-recovery)

Issue: [#34](https://github.com/lbgos/stonehush/issues/34)

## Context

M3 publishes runner-produced bytes as durable evidence. D2 already fences events, redacts stdout and stderr before staging, and requires artifact identity to be unique by Run, fence, event sequence, and declared artifact slot. It does not define how those bytes become immutable files, how the control plane stores them without a shared runner filesystem, or how backup and doctor prove consistency.

v0.1 is a single-user Linux control plane plus one unprivileged local runner. Evidence is plaintext under filesystem permissions. The runner and control plane must not assume a shared filesystem, bind mount, or object store. Remote runners, SaaS storage, deletion UI, and M9 release rehearsal are out of scope.

This ADR defines the `d3-v1` evidence profile. The versioned [acceptance fixtures](./fixtures/d3/) are executable decision records for later contract, API, storage, doctor, and backup tests.

## Decision

### Ownership and topology

The control plane is the sole owner of artifact IDs, upload IDs, staging names, published paths, evidence rows, quotas, doctor findings, and backup manifests. The runner never chooses a storage path, never opens the control-plane SQLite file, and never writes into the evidence root. Bytes move only over authenticated runner HTTP routes.

The managed roots are:

| Role | Path | Mode | Notes |
| --- | --- | --- | --- |
| data directory | `/var/lib/stonehush` | `0700` | control-plane user |
| SQLite database | `/var/lib/stonehush/stonehush.sqlite3` | `0600` | WAL siblings share the directory |
| evidence root | `/var/lib/stonehush/evidence` | `0700` | managed root |
| published artifacts | `/var/lib/stonehush/evidence/published/{artifactId}` | file `0600` | durable evidence |
| staging uploads | `/var/lib/stonehush/evidence/staging/{uploadId}` | file `0600` | in-flight only |

Development storage uses the same relative layout under the isolated development data directory. Fixture and production examples never embed owner home paths.

`artifactId` and `uploadId` are control-plane generated opaque IDs matching `^[a-z0-9][a-z0-9-]{0,126}$`. They contain no `/`, `\`, NUL, `.`, or `..`. Implementation allocates UUID v4 values and lowercases them. Callers cannot supply either ID or any storage path.

Published identity is not the content digest. Two artifacts with identical bytes remain two files and two rows. Digest `sha256:` plus 64 lowercase hex digits is integrity metadata only.

### Authenticated upload

Runner authentication is accepted only on `/api/v1/runner/*` as defined by D2. Evidence capabilities on that surface are:

1. `POST /api/v1/runner/artifacts/grants` — allocate `artifactId` and `uploadId`, reserve quota, and bind `(runId, leaseId, fence, eventSequence, artifactSlot)`.
2. `PUT /api/v1/runner/artifacts/uploads/{uploadId}` — stream at most the remaining per-artifact quota.
3. `POST /api/v1/runner/artifacts/uploads/{uploadId}/complete` — finalize size and digest after the PUT finishes.

Operator and browser credentials are rejected on those routes. Runner credentials cannot download evidence, list another run's artifacts, or supply paths. A grant requires the current unexpired lease, matching fence, pinned session, and a still-nonterminal Run. A stale fence, expired lease, or owner mismatch aborts the upload, leaves any staging file unpublished, and returns the D2 codes `stale_fence`, `lease_expired`, or `lease_owner_mismatch`.

The grant body may include untrusted metadata only: `kind`, `declaredSizeBytes`, `declaredDigest`, `originalFileName`, `declaredContentType`, and `completeness`. Those fields never become open() paths or download `Content-Type`. `artifactSlot` is a plugin-declared token matching the same ID grammar as `artifactId`.

A grant is single-use. A second grant for an in-flight identity returns `artifact_upload_in_progress`. After publication, a later grant or complete for the same `(runId, fence, eventSequence, artifactSlot)` is an idempotent replay when size and digest match, and `artifact_identity_conflict` when they differ. The original file and row are left untouched.

Two `complete` calls on the same `uploadId` are not two sources. The first successful `renameat2` removes the staging name. The loser sees a missing source and an existing destination: it must re-`fstat` that destination and return `stored_artifact_replayed` when digest and size match. It must not require `EEXIST` from `renameat2`. Distinct sources that collide on one destination still map `EEXIST` to `artifact_already_published`.

### Staging, hashing, fsync, and publication

Staging and published directories must share `st_dev` with the evidence root. Startup refuses to serve evidence routes when those three directories are on different devices (`evidence_roots_cross_device`). SQLite may live on another device because backup copies the database as a file.

Publication order is:

1. Authenticate and authorize the grant against the current lease and fence.
2. Open `staging/{uploadId}` with `O_NOFOLLOW | O_CLOEXEC | O_WRONLY | O_CREAT | O_EXCL` and mode `0600` through a no-follow `openat` walk from the evidence root. Reject a pre-existing name.
3. `fstat` the new descriptor: regular file, `nlink == 1`, owner is the control-plane user, mode `0600`, `st_dev` equals the evidence root, size `0`.
4. Stream request bytes into that descriptor while updating SHA-256. Do not buffer the whole artifact. Pause reads when the write pipe or remaining grant reservation is exhausted (backpressure). The grant reservation is the minimum of remaining `perArtifactBytes` and remaining `maxInFlightStagingBytes` at admit time. Streaming cannot exceed that reservation.
5. On complete: `fsync(fileFd)`, close, `fsync(stagingDirFd)`.
6. Compare the streamed digest and size with any declared digest and size. A mismatch returns `artifact_digest_mismatch`, sets the grant to `upload_interrupted`, does not publish, and releases the identity so a later grant may use the same slot.
7. `renameat2(stagingDirFd, uploadId, publishedDirFd, artifactId, RENAME_NOREPLACE)`. `EEXIST` is `artifact_already_published` and leaves the destination untouched. `EXDEV` is `cross_filesystem_staging`; there is no copy-then-unlink fallback.
8. `fsync(publishedDirFd)`.
9. Re-`fstat` the published file through a no-follow open: regular file, `nlink == 1`, owner, mode, device, size, and digest still match.
10. Only then `BEGIN IMMEDIATE` and insert the evidence row with digest, size, relative path `published/{artifactId}`, run identity, completeness, and redaction metadata. The unique key is `(runId, fence, eventSequence, artifactSlot)`.

Supported hosts provide `renameat2` and `RENAME_NOREPLACE`. Plain `rename()` is forbidden because it replaces.

Empty artifacts are valid. The empty digest is `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### Crash recovery

Interrupted states are explicit and are never silently promoted or repaired. The grant row durably stores `putFinalized`, `acceptedBytes`, and `streamedDigest`. `putFinalized` becomes true only after the PUT has received its terminal byte count and the staging file plus staging directory have been fsynced. A mid-stream crash therefore cannot look finalized.

| After crash | Durable file | Grant / row | Recovery |
| --- | --- | --- | --- |
| mid-write (`putFinalized=false`) | staging file | grant `in_progress` or expired | `orphan_staging`; do not publish; do not delete |
| PUT finalized, before rename (`putFinalized=true`) | staging file | grant `in_progress`, lease current | retry `complete` with the stored digest; still metadata-after-file |
| PUT finalized, lease expired | staging file | grant `upload_interrupted` | `orphan_staging`; do not publish |
| after rename and published-dir fsync, before row commit | published file, staging gone | grant `putFinalized=true`, no evidence row | retry `complete` inserts the row only if dest digest, size, device, and `nlink==1` match the grant; unknown extras stay `extra_artifact` |
| after row commit, file missing | none | row present | `missing`; do not recreate bytes |
| after row commit, digest or size mismatch | file present | row present | `corrupt`; do not rewrite file or row |

Control-plane restart scans staging. A staging file whose grant is expired, missing, not `in_progress`, or `putFinalized=false` is `orphan_staging`. In-flight grants whose leases expired become `upload_interrupted`. Restart never infers `putFinalized` from file size, never renames an unfinalized staging file, and never deletes either tree. Only a persisted `putFinalized=true` grant with a still-current lease may retry `complete`. That retry may finish an already renamed destination whose digest matches the grant. Before inserting the row it must `fsync(publishedDirFd)` again so a crash between rename and the first directory fsync cannot advertise undurable bytes. It may not attach an unmatched extra file to a Run. Downloads resolve only committed rows whose files pass the doctor existence and digest checks.

An idle or absolute upload timeout sets the grant to `upload_interrupted` and returns `upload_timeout`. The leftover staging file is later reported as `orphan_staging` by doctor. Timeout does not publish.

### Filesystem defenses

Every evidence open starts at the evidence-root directory descriptor and walks with `O_NOFOLLOW | O_CLOEXEC`. Relative segments come only from control-plane IDs. The implementation rejects:

- any caller-supplied path, including `originalFileName`, working-directory paths, and plugin output paths;
- `..`, `.`, empty, absolute, or separator-bearing segments;
- a symlink at any path component (`artifact_symlink_rejected`);
- a non-regular staging or published file (`artifact_not_regular_file`);
- `nlink != 1` at create, after write, and after rename (`artifact_hardlink_rejected`);
- a destination that already exists (`artifact_already_published`);
- a rename that would leave the source device (`cross_filesystem_staging`);
- a published directory whose device or inode no longer matches the startup-managed published directory.

Directory descriptors used for `renameat2` are rechecked against the startup device and inode immediately before the rename. A replacement of `published/` after startup returns `artifact_published_root_changed` and cannot retarget the already opened directory.

Artifact replacement is impossible even when the new bytes have the same digest as an existing artifact. A matching digest on a different identity creates a second file. A matching identity with a different digest is `artifact_identity_conflict`.

### Quotas, streaming bounds, and truthful completeness

The `d3-v1` quota profile is:

| Control | Default | Minimum | Maximum | Unlimited |
| --- | --- | --- | --- | --- |
| `perArtifactBytes` | 67108864 (64 MiB) | 65536 (64 KiB) | 1073741824 (1 GiB) | unsupported |
| `perRunPublishedBytes` | 268435456 (256 MiB) | 1048576 (1 MiB) | 4294967296 (4 GiB) | unsupported |
| `totalPublishedBytes` | 34359738368 (32 GiB) | 1073741824 (1 GiB) | 1099511627776 (1 TiB) | unsupported |
| `maxInFlightStagingBytes` | 268435456 (256 MiB) | equal to `perArtifactBytes` minimum | equal to `perRunPublishedBytes` maximum | unsupported |
| `maxConcurrentUploadsPerRunner` | 2 | 1 | 8 | unsupported |

Upload idle timeout is 30 seconds without an accepted byte. Absolute upload timeout is 600 seconds or the remaining lease, whichever is shorter. A grant with `declaredSizeBytes` above `perArtifactBytes` is rejected before staging.

Quota exhaustion never deletes, truncates, or replaces an already published artifact.

- Hitting `perArtifactBytes` while streaming stops new accepted bytes. The control plane then evaluates the retained prefix against `perRunPublishedBytes` and `totalPublishedBytes`. Only if those still have headroom does it publish with `completeness=truncated` and reason `artifact_quota_exceeded`, and drain the remainder so the child upload cannot deadlock.
- If the retained prefix would exceed `perRunPublishedBytes` or `totalPublishedBytes`, the current upload is not published. The error is `run_quota_exceeded` or `total_quota_exceeded`. Staging remains unpublished. Published artifacts are unchanged.
- In-flight reservations count against `maxInFlightStagingBytes` and the run/total headroom until the grant finalizes or expires. Grant admission checks `maxConcurrentUploadsPerRunner` first (`concurrent_upload_limit`), then `maxInFlightStagingBytes` (`staging_quota_exceeded`). A second grant for the same in-flight identity remains `artifact_upload_in_progress`. None of these delete already published artifacts.

`complete`, `partial`, `truncated`, and `incomplete` are stored on the artifact or grant. `missing` and `corrupt` are read-time projections over a committed row and are never written back as a completeness update:

| Value | Meaning |
| --- | --- |
| `complete` | every accepted byte was finalized; not quota-truncated |
| `partial` | published after cancel or tool-stop; bytes are a truthful prefix |
| `truncated` | published after the per-artifact cap |
| `incomplete` | the slot was expected but never published |
| `missing` | row exists and the file does not |
| `corrupt` | row exists and size or digest does not match |

Cancellation of a Run does not abort a PUT that already holds a grant: the runner should complete with `completeness=partial`. A dropped connection with `putFinalized=false` leaves `orphan_staging` and the slot `incomplete`. A dropped `complete` after `putFinalized=true` may retry while the lease is current. Timeout or lease expiry does not publish. Failure and cancel preserve any already published artifacts from earlier slots of the same Run.

### Raw evidence, observations, and redaction

A published artifact is immutable and bound to its Run. Parsers, retries, and later observation projections may only reference `artifactId` plus the stored digest. They cannot open the file for write, rename it, or insert a replacement row for that identity.

Raw stream artifacts (`kind=stdout` or `kind=stderr`) arrive after D2 redaction. Their metadata records `redaction.applied=true`, `redaction.boundary=runner_stream`, and `rawBytesPreserved=false`. The published bytes are still immutable evidence, but they are not a claim that original secret bytes were stored.

Tool artifacts (`kind=tool_raw`) store the bytes the tool wrote. Metadata records `redaction.applied=false`, `redaction.boundary=none`, and `rawBytesPreserved=true`. Target-derived secrets that appear in tool output remain in that artifact because stripping them would make the evidence untruthful. They are not copied into logs, events, SSE payloads, or error bodies.

`kind=tool_parsed_input` is a separate artifact when a plugin emits machine-readable output as its own slot. It does not replace `tool_raw`. Its redaction metadata is the same as `tool_raw`: `redaction.applied=false`, `redaction.boundary=none`, and `rawBytesPreserved=true`.

An observation stores `observationId`, `runId`, `artifactId`, `artifactDigest`, plugin identity, optional byte offset and length, and parser version. Re-parsing appends observations. It never mutates the artifact. A metadata document that sets `redaction.applied=true` and `rawBytesPreserved=true` is invalid (`redaction_raw_claim_invalid`).

Logs, structured events, and doctor output may include artifact IDs, sizes, digests, completeness, and fixed error codes. They must not include artifact bytes, runner credentials, API keys, flags, or unsanitized original file names.

### Safe download

Operator download is `GET /api/v1/engagements/{engagementId}/artifacts/{artifactId}/content`. The artifact must belong to that engagement. Runner credentials on that route return `operator_identity_required`. Operator credentials on runner upload routes return `runner_identity_required`. An unknown artifact ID or an artifact that belongs to another engagement returns HTTP 404 `artifact_not_found` and no body, so membership is not leaked.

Successful responses always send:

```text
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="artifact-fixture-8-bin"
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

`declaredContentType` is ignored, including `text/html` and `image/svg+xml`. Inline disposition is forbidden. `Range` is not implemented: a request that includes `Range` returns HTTP 400 `range_not_supported` and no body.

`filename` is `artifact-{artifactId}-bin` unless `originalFileName` is already a single segment matching `^[A-Za-z0-9_-]{1,128}$`. Names that are empty, `.`, or `..`, or that contain `.`, `/`, or `\`, are rejected wholesale. The implementation does not keep a leftover basename after stripping path segments. Unsafe names are replaced, never echoed. The hyphenated `-bin` suffix avoids emitting an untrusted dotted extension as an executable hint.

`missing` artifacts return `missing_artifact` and no file bytes. `corrupt` artifacts return `corrupt_artifact` and no file bytes.

### Doctor

`stonehush doctor` evidence checks are read-only. They never rewrite, restat-as-repair, or delete. The check walks no-follow from the evidence root and verifies:

- every evidence row has a regular file at exactly `published/{artifactId}`;
- size and streaming SHA-256 match the row;
- owner is the control-plane user and mode is `0600`;
- `nlink == 1`;
- the resolved path stays inside the managed root on the startup device and inode;
- every file under `published/` has a row;
- every file under `staging/` is either an unexpired `in_progress` grant or `orphan_staging`;
- SQLite foreign keys from artifacts to runs hold.

Findings use the codes `healthy`, `missing_artifact`, `corrupt_artifact`, `unsafe_ownership`, `unsafe_link_count`, `extra_artifact`, `orphan_staging`, and `path_escape`. `path_escape` is fatal for serving. No finding silently restores bytes.

### Backup and restore

Backup protocol `stonehush-backup-v1` produces a consistent SQLite-plus-published-artifact snapshot. Staging is excluded.

1. The destination directory must be empty. Otherwise `backup_destination_not_empty`.
2. Create an `INCOMPLETE` marker and acquire the backup lock. The lock blocks new grants and publication with HTTP 503 `storage_backup_quiesced`. Doctor remains read-only.
3. Copy SQLite with the better-sqlite3 backup API into `sqlite/stonehush.sqlite3` so the backup is a standalone consistent database.
4. Copy each published artifact through no-follow opens into `evidence/published/{artifactId}` and verify size and digest after copy. Do not hardlink live files.
5. Write `backup-manifest` with protocol `stonehush-backup-v1`, UTC timestamp, schema version, SQLite digest, artifact list `{artifactId,sizeBytes,digest}`, and counts. `fsync` files and directories.
6. Set manifest `state=complete`, `fsync`, remove `INCOMPLETE`, release the lock.

An interrupted backup keeps `INCOMPLETE` or a manifest whose `state` is not `complete`. Restore refuses it with `backup_incomplete`.

Restore:

- Destination data directory must contain no SQLite file and no `evidence/` tree. Any existing file is `restore_destination_not_empty`.
- The backup must be complete. Then verify SQLite digest and every listed artifact before any write.
- A digest, size, or membership mismatch is `restore_consistency_mismatch` and writes nothing.
- A backup schema version newer than the running binary is `restore_schema_newer`. An older schema restores files and then applies append-only migrations on first start.
- Restore creates files with owner the intended control-plane user, directories `0700`, and files `0600`.
- After copy, verify again. Failure leaves `INCOMPLETE` in the destination and the destination must not be used as a live data directory.

M9 rehearses this protocol on supported hosts. M3 must implement the same commands and refusal codes.

Owner retention and deletion are a separate documented operation. v0.1 never auto-deletes published artifacts for quota, retry, parser update, or doctor. Export is a read-only authorized copy and is not a backup.

## Alternatives considered

### Shared runner and control-plane filesystem

Rejected because a local bind mount or common data directory would let an unprivileged runner process observe or race control-plane files. Upload over the existing runner API keeps the trust boundary identical to D2.

### Digest-addressed published paths

Rejected because a second artifact with the same digest would replace or alias the first. Content addressing remains a stored SHA-256. Path identity stays a generated artifact ID bound to the Run.

### Copy across filesystems

Rejected because copy-plus-unlink is not atomic and creates a replace window. Staging and published stay on one device and use `RENAME_NOREPLACE`.

### Insert metadata before the durable rename

Rejected because a crash would advertise a digest that no file can satisfy. Extra unpublished files are safer than serving missing bytes. Doctor reports extras; it does not invent rows.

### Silent doctor or restore repair

Rejected because reconstructing bytes, loosening link counts, or importing extras would hide loss and could attach the wrong content to a Run.

### Cloud object storage or remote runners

Rejected for v0.1. The local filesystem protocol is the accepted baseline.

## Consequences

M3 can implement upload, publication, download, doctor, and backup against one profile. Operators get truthful partial evidence and a refuse-closed restore path. The cost is more metadata, exclusive quotas, and a backup lock that briefly pauses publication.

D5 must not let plugins choose artifact paths. D6 must treat published bytes as untrusted and must not assume stream artifacts still contain pre-redaction secrets. D7/M9 rehearse this backup protocol rather than inventing another.

This ADR defines behavior only. It does not add runtime storage, routes, doctor commands, or backup binaries.

## Safety and privacy

Caller-supplied paths never reach `open`. Published raw artifacts are immutable and never silently replaced. Quota failure cannot drop already published artifacts. Redaction metadata cannot claim that redacted stream bytes are original raw bytes. Logs and fixtures contain no secrets, owner paths, or real targets. Downloads cannot execute active content. Missing and corrupt states stay visible.

## M3 follow-up map

Implement D3 through separate bounded issues in this order:

1. **Evidence contracts:** versioned artifact, grant, completeness, and redaction types that consume these fixtures.
2. **Upload grants and quotas:** authenticated runner grants, reservations, and backpressure.
3. **Publication:** no-follow staging, streaming SHA-256, fsync, `RENAME_NOREPLACE`, and metadata-after-file.
4. **Download:** operator authorization, fixed headers, and sanitized names.
5. **Doctor:** read-only integrity findings without repair.
6. **Backup and restore commands:** `stonehush-backup-v1` with the refusal codes above. Host rehearsal stays in M9.

## Acceptance evidence

- [Publication fixtures](./fixtures/d3/publication.json) pin generated IDs, digest and fsync order, no-replace, replay, and identity conflicts.
- [Limit fixtures](./fixtures/d3/limits.json) pin quota numbers, partial upload, cancel, timeout, truncation, backpressure, and preservation of published artifacts.
- [Path-defense fixtures](./fixtures/d3/path-defenses.json) pin traversal, absolute paths, symlinks, hardlinks, overwrite, rename races, and cross-filesystem refusal.
- [Recovery fixtures](./fixtures/d3/recovery.json) pin orphan staging, missing files, extras, finalized complete retry, and no silent repair.
- [Privacy and download fixtures](./fixtures/d3/privacy-download.json) pin raw versus redacted metadata, observation linkage, headers, names, range refusal, and truthful missing or corrupt downloads.
- [Doctor fixtures](./fixtures/d3/doctor.json) pin healthy, missing, corrupt, wrong-owner, link-count, extra, orphan, and escape findings.
- [Backup fixtures](./fixtures/d3/backup.json) pin a consistent snapshot, interrupted backup, empty restore, non-empty refusal, and consistency mismatch.
- `node --test scripts/check-docs.test.mjs` checks the exact fixture file and case-ID set, fingerprints every critical input and exact outcome, and mutation-tests fail-closed behavior.
- Runtime implementation, deletion UI, shared filesystems, remote runners, object storage, and M9 rehearsal are outside this decision.
