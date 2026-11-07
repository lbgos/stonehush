# Native runner service

Use the native Linux x86-64 archive built from the **same source commit and tree** as the control-plane image. Protocol negotiation alone does not certify mixed builds. The archive contains Node 24.18.0, compiled runner code and the frozen pnpm 10.24.0 runtime dependency closure. It needs no source checkout, package manager or dependency install on the operator host.

Build privately from a committed checkout on a disposable Linux builder with Node 24.18.0 and pnpm 10.24.0:

```sh
node scripts/build-native-runner.mjs /absolute/new/native-runner.tar.gz
```

The builder uses `git archive HEAD`, a frozen dependency install and a fresh build. The adjacent `native-runner.tar.gz.json` records source identities and the archive SHA-256. Compare these identities with the control-plane metadata. Verify the archive digest through your trusted delivery path before extracting it into a new directory. Internal fingerprints detect changed files; they are not a signature or a trust decision. No registry, release tag or publication is part of this path.

## Install and enroll

Use an existing dedicated unprivileged account with a private mode-0700 home, no Docker group/socket access and no access to control-plane SQLite/evidence storage. Account provisioning is the host administrator's responsibility. The installer refuses root, linked directories, writable ancestors and exposed private directories. It does not create accounts, change permissions on existing paths, install tools, configure networking or enable lingering. The host must already provide systemd user services, `/usr/bin/systemctl` and `/usr/bin/systemd-notify`.

Run all following commands as that account. Replace the archive, origin, executable and runner name explicitly. The executable and wordlists remain operator-managed. The initial service uses unprivileged actions and grants no capabilities or sudo access.

```sh
sha256sum /absolute/native-runner.tar.gz
mkdir /absolute/new-extraction
tar -xzf /absolute/native-runner.tar.gz -C /absolute/new-extraction
cd /absolute/new-extraction/stonehush-runner
./node scripts/native-runner-service.mjs install http://127.0.0.1:8787 /usr/bin/nmap 'Local runner'
```

Installation copies the artifact into `~/.local/share/stonehush-runner`. Configuration and credentials use `~/.config/stonehush-runner`; outbox state uses `~/.local/state/stonehush-runner`; action working directories stay under its separate `work` directory. These directories use 0700 and identity files use 0600. Artifact dependency symlinks stay inside the copied distribution. The service unit is `~/.config/systemd/user/stonehush-runner.service`. Existing conflicting runtime, configuration or unit files are refused. Repeating the same install preserves identity and state.

Start the matching Compose control plane first. Inspect the selected API origin, runner name, public fingerprint and source identity:

```sh
cd ~/.local/share/stonehush-runner
./node scripts/native-runner-service.mjs identity
```

Only after verifying those values, explicitly confirm enrollment:

```sh
./node scripts/native-runner-service.mjs enroll --owner-confirmed
systemctl --user daemon-reload
systemctl --user enable --now stonehush-runner.service
systemctl --user status stonehush-runner.service
```

Enrollment uses the existing challenge and owner-confirmation endpoints. It saves the one-time secret privately and never prints it or supplies it in argv. Service startup never enrolls. A successful systemd start requires an accepted runner handshake; `activating` means that readiness has not been established. The API's existing action readiness remains authoritative for connection and tool availability after startup. The packaged `stonehush doctor` still verifies control-plane evidence integrity only.

The user manager normally follows login lifetime. Starting at boot without login requires host-administrator configuration of this dedicated account's user manager or lingering. The package neither enables it nor promises unattended boot where it is absent. The unit stops its whole cgroup, uses a 0077 umask and prevents privilege gains. It does not grant resource-controller capabilities or change the runner's existing capability negotiation.

## Restart, stop and remove

```sh
systemctl --user restart stonehush-runner.service
systemctl --user stop stonehush-runner.service
cd ~/.local/share/stonehush-runner
./node scripts/native-runner-service.mjs remove
```

Removal requires the service to be inactive. It disables and removes only the matching unit and verified installed runtime. It preserves configuration, credential, enrollment record, state and working directories. It does not revoke the API identity. Reinstalling the same artifact with the same configuration can reuse that association. Different artifacts require an explicit stop/removal and a matching control-plane upgrade; this is not an automatic upgrade or arbitrary compatibility promise.

To retire the association, stop the service, inspect the recorded nonsecret runner ID and revision, then explicitly revoke **that identity** through the existing operator endpoint `POST /api/v1/runners/<id>/revoke` with a fresh `Idempotency-Key` and `{"expectedRevision":<revision>}`. Only after verified revocation should the operator remove retained private credential/configuration/state files if desired. Removal deliberately does not automate that data deletion.

If enrollment fails, preserve `enrollment-attempt.json`. A lost response may have enabled an identity. Inspect the API enrollment state and recover only the matching identity before removing the credential/attempt record and explicitly enrolling again. A missing, malformed or revoked credential never triggers silent enrollment or revocation. Credentials are not recoverable from the API.

## Acceptance boundary

The PR packaging workflow builds and consumes both artifacts at the exact head on separate disposable Ubuntu 24.04 and 22.04 x86-64 VMs, one host at a time. Each host tests a real systemd user service. Its synthetic executable proves action argv, cancellation, exact evidence, credential exclusion, private modes, restart/reinstall association and stop/removal. A separate loopback workflow uses that VM's actual distribution Nmap and ffuf, with observed versions, package provenance and executable hashes, exact evidence/finding/report references, active ffuf cancellation and truthful partial bytes. The private per-run ffuf configuration and controlled environment remain required.

Per-host receipts identify the image/native archive and source/tree, with build and consumption host facts recorded separately. A passing 22.04-built archive on 22.04 proves that pair only. It does not prove that a 24.04-built archive runs on 22.04 or settle a universal binary policy. Only bounded synthetic evidence and provenance are retained, without credentials, databases or raw service logs. Scheduled checks alone do not pass a host gate. Kali and other build/host/tool combinations remain unproven. The job does not install on the developer host or publish the archive. Public release, redistribution clearance, trusted checksum delivery, signing and broader M9/M10 gates remain separate.


The build creates an adjacent `.supply-chain/` companion packet with an artifact-bound SPDX 2.3 inventory, retained upstream notices and unsigned checksums. The same notice/input files are included in the archive and covered by its internal fingerprints. See [supply-chain inventory verification](README.md#supply-chain-inventory). Node's upstream text includes third-party terms; missing or unresolved obligations remain visible and redistribution is `NOT CLEARED`. The packet does not bundle external tools, wordlists, systemd or host shared libraries.
