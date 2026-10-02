# Runner startup

Normal startup runs two things: the app and the local runner. The dev
starter enrolls when credentials are missing, or reuses both credential
variables when set. It keeps the secret in process memory only.

## First time and every restart

Complete the [README quick start](../../README.md#quick-start), then start
the app with `pnpm dev` and wait for the API. In a second shell run
`pnpm runner:dev`. The starter checks for `nmap`, waits for the dev API at
`http://127.0.0.1:3001` by default, calls the existing enrollment challenge
and confirm endpoints with owner confirmation, and starts the existing
runner. It writes no credential file and prints no secret.

There is no enrollment screen in the web app. An earlier version of this
page named one; that UI is not in the source.

If `STONEHUSH_RUNNER_ID` and `STONEHUSH_RUNNER_SECRET` are already set, the
starter reuses them and skips enrollment. If only one of them is set, it
stops with a clear error. A fresh shell without those variables enrolls
again after successful cleanup. A lost credential is not recoverable.

The starter stops only its owned child, then revokes only the identity it
successfully enrolled during this launch, including after a startup failure.
It never revokes an identity supplied through environment credentials. The
API permits only one enabled runner, so a lost confirmation response, hard
process kill, or failed revocation can leave an identity that blocks enrollment.
The starter reports uncertain confirmation or cleanup and does not guess an
identity or revoke another runner.

For a known leftover identity, explicit operator recovery uses
`POST /api/v1/runners/<recorded-runner-id>/revoke`, a fresh `Idempotency-Key`,
and `{"expectedRevision":<recorded-runner-revision>}`. The starter prints the
nonsecret id and revision on successful enrollment. When confirmation was
lost, inspect the configured API's enrollment state before choosing the
identity. Do not retry enrollment by revoking an unrelated runner.

## Same work after restart

Queued runs wait for the runner instead of failing. The opening screen offers
Resume for the last opened engagement, or the most recently updated one when
the stored id no longer exists. A restarted runner handshakes with a new
session and reports abandoned work. The server keeps leases, fences, and
terminal results across a control-plane restart.

## When a run does not move

| What you see | Meaning | Fix |
| --- | --- | --- |
| Run stays queued, readiness says the runner has it | Runner disconnected or not started | Start the runner, then retry |
| Last run failed with the runner gone mid-run | Runner disconnected mid-run, the target may never have been reached | Start the runner and retry |
| Last run failed, Nmap unavailable | Nmap is missing for the runner host | Install nmap or fix the runner executable, then retry |
| Last run finished with no new services | The target did not answer | Check the target and lab, then retry |
| Advisor not set up | Model endpoint missing, manual work unaffected | See [Advisor setup](advisor-setup.md) when you want it |

The guided demo, if one is offered, stays a separate optional workspace. It is
never part of the restart path above.
