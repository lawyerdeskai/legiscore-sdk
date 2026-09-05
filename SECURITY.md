# Security policy

## Reporting a vulnerability

Email **info@legiscore.in** with a description and reproduction steps, and put "security" in the
subject line. Please do not open a public issue for a suspected vulnerability, and please do not
test against another organisation's data.

We acknowledge within **two business days** and will tell you what we intend to do and roughly
when. We will credit you when a fix ships, unless you would rather we did not.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

Both packages ship from one tag and carry the same version, so a Python and a Node integration on
the same number get the same behaviour. Fixes land on the newest release; there is no backport
branch.

## Scope

**In scope** — anything in this repository:

- the Python package `legiscore` and the npm package `@legiscore/sdk`
- the React package in `views/`
- `spec/legiscore-openapi.json` and the build scripts that produce it
- the Postman collections and the guide in `integrations/`

Report anything that lets one of these leak a key, verify a webhook it should reject, send a
request somewhere it should not, or execute something a caller did not ask for.

**Out of scope here, same address** — the LegiScore API itself, the dashboard and anything served
from `legiscore.in`. Send those to the same mailbox; they are simply not fixed by a release of this
repository.

Also out of scope: findings that depend on an attacker already holding your API key or already
having code execution on your server, and reports produced only by an automated scanner with no
demonstrated impact.

## What this package is, and is not

This SDK is a **convenience layer**. It is not a security boundary, and it is designed on the
assumption that its source is fully public and freely modifiable.

- **It holds no secrets.** Your API key is read from your environment or passed by you at
  construction. Nothing credential-shaped is committed here, and no release ships one.
- **It enforces nothing.** Authentication, authorisation, tenant isolation, permissions, rate
  limits, usage and billing limits, upload validation and object-level ownership are all enforced
  by the API. Editing this package to call an endpoint you are not entitled to call does not grant
  access; the request is refused server-side.
- **It contains no proprietary logic.** Document interpretation, scoring, prompts and the report
  engine are server-side and are not distributed here.

## Handling your API key

- Read it from the environment (`LEGISCORE_API_KEY`); never commit it or hard-code it.
- Leave **Allowed domains empty** for a server-side key, and set it for a browser-adjacent one.
- The Node client keeps the key non-enumerable so `console.log(client)` and `JSON.stringify(client)`
  do not print it, but a key in a log line, a crash report or a URL is still a leaked key.
- Rotate immediately if exposed. Keys are per organisation; a leaked key is scoped to that
  organisation's data and usage.

## Webhooks

Always verify. `verify_webhook` / `verifyWebhook` checks an HMAC-SHA256 signature over the raw body
plus a timestamp, and rejects deliveries outside a five-minute window. Key your handling on the
delivery id so a legitimate redelivery is idempotent.
