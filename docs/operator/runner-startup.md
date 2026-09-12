# Runner startup

Normal startup runs two things: the app and the local runner. Enrollment is a
one-time setup. A routine restart needs no enrollment tokens, no native build,
and no port numbers.

## First time only

Complete the [README quick start](../../README.md#quick-start), then enroll
the runner once from the loopback UI with owner confirmation. The secret is
shown once. Keep it where the runner process reads it. A lost credential is
not recoverable: revoke the identity and enroll again.

## Every restart

1. Start the app with `pnpm dev` from the repository root and open the printed
   local address in the browser.
2. Start the runner with its stored identity. The runner reconnects on its own
   with a new session and reports abandoned work. The server keeps leases,
   fences, and terminal results across a control-plane restart.

No new challenge, no token paste, and no rebuild belong in this path. If a
step asks for them, stop and treat it as a fresh enrollment, not a restart.

## Same work after restart

Queued runs wait for the runner instead of failing. The opening screen offers
Resume for the last opened engagement, or the most recently updated one when
the stored id no longer exists. The app to runner relationship is retained by
the stored runner identity and the surviving leases, not by anything the
tester re-enters.

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
