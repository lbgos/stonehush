# Round 31 fix final

Finding: CodeRabbit 4503941807 on PR 208.

## Source snapshot

- Confirmed PR head before this fix: `e67db80955844a83503f229979ace6b5dbf3e732`
- Confirmed head tree: `65a23c163a5fff5f6a5b8cb9e59ff90428db322d`
- Fix commit head: `0ff62f13cc91dace1a67c42633e6b3cd6a597a91`
- Fix commit tree: `c9fffed16f61735a0dd14fae699abe374951a17d`
- Final branch head: `fd0aa9336a5a8dbc0d81ad44ba498bfc16fab77f`
- Final branch tree: `f1da7d38ceb63ff85ada151d4f97a79dcb64e771`
- PR base: `main` at `09c56feb228073f5fd8ab88030d12940f25dd57c`
- Requested branch: `t3/release-component-inventory`

## Before-fix independent failure

Using the confirmed head implementation, a deterministic native-runner fixture removed `nativeFiles[0]`, refreshed `components.json` and `artifact.json`, and ran packet generation. The baseline accepted the package:

```text
baseline finding reproduction: omitted native file entry is accepted
ok (test passed)
```

This reproduced the finding: the artifact still contained `node`, but verification only re-hashed the paths named by `components.json`.

## Correction

`isNativeFile` now owns the existing `*.node`, `node`, executable-mode, and `supply-chain/` exclusion rule. Collection and verification use that helper. `verifyInputs` rebuilds the expected native path set from the artifact tree, validates listed paths, and compares the sets exactly before digest checks. Asset completeness and other inventory fields are unchanged.

A focused regression removes the native entry, refreshes `components.json`, `artifact.json`, `sbom.spdx.json`, `inventory.json`, and `SHA256SUMS`, and requires `Native file inventory mismatch`.

## Verification

- `prlimit --as=4294967296 -- taskset -c 6,7 timeout --foreground 1200s env NODE_OPTIONS=--max-old-space-size=3072 node --test scripts/release-inventory.test.mjs`: 68 passed.
- `prlimit --as=4294967296 -- taskset -c 6,7 timeout --foreground 1200s env NODE_OPTIONS=--max-old-space-size=3072 node --test scripts/control-plane-package.test.mjs scripts/native-runner-archive.test.mjs`: 5 passed.
- `prlimit --as=4294967296 -- taskset -c 6,7 timeout --foreground 1200s env NODE_OPTIONS=--max-old-space-size=3072 node scripts/check-files.mjs syntax`: passed.
- `prlimit --as=4294967296 -- taskset -c 6,7 timeout --foreground 1200s env NODE_OPTIONS=--max-old-space-size=3072 node scripts/check-files.mjs format`: passed.
- `prlimit --as=4294967296 -- taskset -c 6,7 timeout --foreground 1200s env NODE_OPTIONS=--max-old-space-size=3072 node scripts/check-docs.mjs`: passed.
- Baseline reproduction on the confirmed pre-fix head: accepted the omitted native file.
- `git diff --check`: passed.

The bounded checks used no full suite, build, Docker image, service, port, or live target.

## Limitations and next gate

No full repository suite, build, Docker image, service, port, or live target was used. The next gate is CI on the pushed PR head followed by the required full review pass and owner merge decision.
