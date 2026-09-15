# Advisor setup

Point Stonehush at any OpenAI-compatible model endpoint and ask grounded
questions about engagement evidence. This page covers setup only; it does
not promise any particular model or result quality.

## Prerequisites

- A running control plane. For development: `pnpm dev` from the repository
  root (API on 3001, web on 5173, isolated storage under `.stonehush/dev`).
  A production API process needs `STONEHUSH_DATA_DIR` set to an absolute
  path and a port via `STONEHUSH_API_PORT`. Complete the [README quick start](../../README.md#quick-start) first, including its one-time native build: advisor turns read the
  evidence store, so without it the turn routes stay unregistered.
- A model server reachable **from the control-plane host** (not from your
  browser). The server must accept OpenAI-style chat requests with
  `response_format: {"type": "json_object"}` and answer `POST
  <prefix>/chat/completions` with an OpenAI-style response envelope whose
  `choices[0].message.content` string contains exactly one JSON object with the
  documented fields (`profile`, `answer`, `citations`, `abstained`,
  `uncertainty`); a local llama-swap instance or any other compatible
  runner qualifies only if it follows that contract. Servers that emit
  free-form prose fail closed with parse errors. No model software ships
  with Stonehush, and no live compatibility with any specific model is
  claimed here.

## 1. Export the API key, if your server needs one

There is no dotenv loader: set the variable in the same environment that
starts the API process (the shell running `pnpm dev`, a systemd unit
`Environment=` line, or your supervisor config), then restart the API so it
picks the value up. The key is read by name on every turn request.

```bash
export STONEHUSH_ADVISOR_API_KEY="<paste-the-real-key-here-in-your-shell-only>"
```

Leave this whole step out when the server needs no auth. Never paste a key
into Settings, chat, logs, or the repository: Settings rejects values that
look like key material, and only the variable **name** is ever stored.

## 2. Fill in Settings, Advisor section

- **Endpoint base URL.** Scheme plus host plus API prefix, verbatim, for
  example `http://<inference-host>:<port>/<prefix>`. The control plane
  strips trailing slashes and posts to `<base>/chat/completions`, so
  `http://<inference-host>:<port>/v1` reaches
  `http://<inference-host>:<port>/v1/chat/completions`. Only `http` and
  `https` are accepted, and the URL must not embed credentials, a query
  string, or a fragment. A wrong prefix or subpath saves without complaint
  and fails later at request time, so copy it exactly from your server.
- **Model.** The model name exactly as your server advertises it. It is sent
  verbatim in the request body (max 128 characters, no leading or trailing
  spaces). Stonehush never lists or validates it; an unknown name fails
  when the provider answers.
- **API key variable.** The environment variable **name** (capitals,
  digits, underscores), or empty for no auth.
- **Public endpoint opt-in.** Loopback (`127.0.0.0/8`, `::1`, `localhost`,
  `*.localhost`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local
  (`169.254/16`), unique-local IPv6, and `.local` names are private and need
  no opt-in. Any other hostname or address is public: without opt-in the
  control plane refuses to contact it before any packet is sent. Checking
  the box authorizes evidence-adjacent prompts to leave the host for that
  endpoint.

Save, then use **Test connection**.

## 3. Read the connection status honestly

`GET /api/v1/advisor/status` reports one of `unconfigured`,
`missing_key_env`, `key_unset`, `public_not_opted_in`, `probe_failed`,
`unreachable`, or `ok`, plus the bare endpoint host, round-trip latency,
and key present/absent (never the key). The probe is a bare `GET` with no
auth and no payload:

| Reason | Meaning | Fix |
| --- | --- | --- |
| `unconfigured` | Endpoint or model is empty | Fill in Settings and save |
| `missing_key_env`, `key_unset` | The named variable is missing or empty in the **API process** environment | Export it where the API runs, restart the API |
| `public_not_opted_in` | Public-looking host, box unchecked; no packet sent | Check opt-in or move the server to a private address |
| `probe_failed` | URL unparsable or the probe errored/timed out | Fix the base URL, start the server |
| `unreachable` | No HTTP response within budget | Start the server, open the firewall, fix host/port |
| `ok` | The endpoint answered **some** HTTP response | None; proceed to a real question |

`ok` is reachability, not completion compatibility: it never sends a chat
request, so a server that answers `GET` but rejects chat payloads still
reports `ok`. The first real proof is an actual turn.

## 4. Ask a question

Open an engagement, keep at least one preserved evidence excerpt selected
(a finding-only question still needs an excerpt), type a question, and Ask.
If it fails: `provider_error` / `provider_timeout` means the server errored
or exceeded the 75-second budget; `context_too_large` means trimmed
selection; `unknown_artifact` / `unknown_finding` means re-pick current
evidence; `key_unset` / `advisor_unconfigured` means redo steps 1-2. Cancel
stops only the client wait; the stored turn keeps its persisted status.

## Generic llama-swap notes

Serve with an OpenAI-compatible endpoint enabled, note the listen address,
port, path prefix, and model name, and enter them as above using your own
values. Nothing about your machine (IPs, hostnames, ports, model names,
keys) belongs in the repository, issues, or docs: placeholders only.
