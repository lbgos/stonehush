# Compose control plane

This packages the production API, web app and `stonehush` evidence CLI for Linux x86-64. Pair it with the [matching native runner service](native-runner.md), using its own unprivileged user and credential directory. Never mount control-plane data into the runner.

Build on a disposable Docker builder with enough space for the Node build image, dependencies, compiled output and image archive. From a committed checkout:

```sh
node scripts/build-control-plane.mjs stonehush-control-plane:rc /absolute/new/control-plane.tar
```

The helper builds only `HEAD`, using Node 24.18.0, pnpm 10.24.0 and the frozen lockfile. It loads the image locally, saves a loadable archive, and writes the source commit/tree, image ID and archive SHA-256 to `control-plane.tar.json`. Build output includes `artifact.json` with runtime-file and migration fingerprints. This does not claim byte-identical images across builders.

On the operator's Linux host, load the verified archive and start one control plane:

```sh
docker image load --input /absolute/control-plane.tar
docker image tag <imageId-from-verified-control-plane.tar.json> stonehush-control-plane:rc
export STONEHUSH_IMAGE=stonehush-control-plane:rc
docker compose -f compose.yaml up -d
```

Open `http://127.0.0.1:8787`. Set `STONEHUSH_PORT` before starting if that port is occupied. Host networking keeps the server's IPv4 loopback bind and peer checks intact. There is no port publication, LAN listener, forwarded-header trust, privileged mode or Docker socket mount. Requests require the selected loopback authority and a matching Origin when supplied. Use that same loopback URL in the native runner configuration and enroll through the existing owner-confirmed path. The container runs as UID/GID 10001; `/data` is private to it. Docker access itself is privileged host authority.

Readiness and the existing evidence-only doctor:

```sh
docker compose -f compose.yaml ps
docker compose -f compose.yaml exec control-plane stonehush doctor
```

For a same-version backup, first drain or cancel active work. A private empty directory inside the data volume can hold the snapshot:

```sh
docker compose -f compose.yaml exec control-plane node -e "require('node:fs').mkdirSync('/data/snapshot',{mode:0o700})"
docker compose -f compose.yaml exec control-plane stonehush backup /data/snapshot
```

Copy `/data/snapshot` out with `docker compose cp` to private storage and retain the matching image, runner and digest metadata. Check the copy before relying on it. It contains plaintext assessment data. A backup inside the live volume alone is not disaster recovery.

To rehearse recovery, stop the control plane and use a new empty volume. Substitute explicit snapshot and new volume paths/names below. The snapshot must be readable by UID 10001, with its original private file modes. Never reuse or remove the original data volume during a rehearsal.

```sh
docker compose -f compose.yaml stop
docker run --rm --network none --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --mount type=volume,src=stonehush-restore-test,dst=/data --mount type=bind,src=/absolute/private/snapshot,dst=/snapshot,readonly --entrypoint stonehush "$STONEHUSH_IMAGE" restore /snapshot
docker run --rm --network none --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --mount type=volume,src=stonehush-restore-test,dst=/data --entrypoint stonehush "$STONEHUSH_IMAGE" doctor
```

Restore refuses incomplete/corrupt backups, newer schemas and nonempty destinations. The first supported baseline is the current 27-migration journal. Same-version backup/restore is the initial support claim; historical development-database upgrades are not certified. Future published v0.1 migrations remain append-only and require release-pair verification. Recovery restores the pre-upgrade snapshot with its matching old builds, without down-migrations.

The pull-request packaging workflow builds and consumes matching image/native archives at the exact PR head on separate disposable GitHub-hosted Ubuntu 24.04 and 22.04 x86-64 VMs, one host at a time. It preserves the pinned Debian control-plane userspace. Each host runs the same Compose, recovery, user-service and real distribution Nmap -> HTTP probe -> ffuf -> evidence/finding/report checks, including active ffuf cancellation and truthful partial evidence. Tools come from that VM's configured distribution repositories; their observed versions, package ownership and executable hashes are retained.

Per-host artifacts record source/tree, image/archive identities, separate observed build and consumption hosts, kernel, systemd, Docker/Compose and runtime versions, stages, cleanup and bounded synthetic evidence. A passing rebuilt archive proves only its recorded build/consumption pair. It does not establish cross-host binary compatibility or a universal native archive. Three fixed-viewport screenshots come from each image and require owner comparison with accepted UI evidence. Scheduled jobs alone are not acceptance receipts. Kali, other tool/build/host combinations, historical upgrades, trusted publication checksums, SBOM, signing and broader M9/M10 gates remain separate. The workflow publishes no image or native archive. Ordinary repository CI may test GitHub's merge ref separately.
