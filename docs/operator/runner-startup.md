# Runner startup

Normal startup runs two things: the app and the local runner. The dev
starter enrolls each time and keeps the secret in process memory only.

## First time and every restart

Complete the [README quick start](../../README.md#quick-start), then run
`pnpm dev:all` in one shell. It validates configuration and credentials,
checks `nmap` and free API/web ports, starts its own API and web app, and
starts the runner through the existing enrollment and owner-confirmation
endpoints. Readiness requires the API's successful bind, the web page and
proxied health response, and the runner's accepted handshake. Ctrl+C stops
only children started by this command.

The defaults are `http://127.0.0.1:3001` for the API and
`http://127.0.0.1:5173` for the web app. Existing port and data-directory
environment overrides still apply. For `dev:all`, an explicit
`STONEHUSH_API_BASE_URL` must select the API started by that command. An
occupied API or web port fails before children or enrollment, even if the
existing API is healthy. It never adopts a running service.

For separate processes, start `pnpm dev`, then `pnpm runner:dev` in another
shell. The standalone runner waits for the selected API and supports an
explicit API URL. Both starters write no credential file or secret log.

There is no enrollment screen in the web app. An earlier version of this
page named one; that UI is not in the source.

If `STONEHUSH_RUNNER_ID` and `STONEHUSH_RUNNER_SECRET` are already set, the
starter reuses them and skips enrollment. If only one of them is set, it
stops with a clear error. A fresh shell without those variables enrolls
again. A lost credential is not recoverable: stop the runner and enroll
again.

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
