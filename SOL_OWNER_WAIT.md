# Owner wait: PR 208 Round 31

Finding 4503941807 is corrected on the isolated implementation branch.

## Source and identity

- Pre-fix PR head: `e67db80955844a83503f229979ace6b5dbf3e732`
- Pre-fix head tree: `65a23c163a5fff5f6a5b8cb9e59ff90428db322d`
- Fix commit head: `0ff62f13cc91dace1a67c42633e6b3cd6a597a91`
- Fix commit tree: `c9fffed16f61735a0dd14fae699abe374951a17d`
- PR base: `main` at `09c56feb228073f5fd8ab88030d12940f25dd57c`
- Commit author and committer required: `285507185+lbgos@users.noreply.github.com`

## Before-fix failure

A copied confirmed-head implementation accepted a native-runner artifact after `nativeFiles[0]` was removed and `components.json` plus `artifact.json` were refreshed. The artifact still contained `node`; the old verifier did not rebuild the expected native set.

## Fix and regression

The shared native-file classifier is used by both collection and verification. Verification excludes supply-chain paths, rebuilds native paths from the artifact tree, validates safe listed paths, and compares the exact set. The regression expects omission rejection after refreshed manifests and sidecars. Asset completeness and unrelated inventory fields remain unchanged.

## Bounded checks

Run each command with affinity to CPUs 6 and 7, a 4 GiB address-space limit, `NODE_OPTIONS=--max-old-space-size=3072`, and a 1200 second timeout:

- `node --test scripts/release-inventory.test.mjs`: 68 passed.
- `node --test scripts/control-plane-package.test.mjs scripts/native-runner-archive.test.mjs`: 5 passed.
- `node scripts/check-files.mjs syntax`: passed.
- `node scripts/check-files.mjs format`: passed.
- `node scripts/check-docs.mjs`: passed.
- `git diff --check`: passed.

No full suite, build, Docker image, service, port, or live target was used.

## Next gate

Wait for CI on the pushed PR head and the full independent review gate. The owner decides merge; this work does not merge PR 208.
