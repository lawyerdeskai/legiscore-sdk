# Integrations

Everything for driving the API by hand, and the pack you hand a partner before they write a line
of code.

| File | What it is |
|---|---|
| `legiscore.postman_collection.json` | **The one you send.** The report flow in the order you run it, folders numbered 0 to 8, with the failure modes we have actually hit written on each request. |
| `legiscore-reference.postman_collection.json` | Every operation in the spec, grouped by module. Generated, so it cannot drift. The one you look things up in. |
| `legiscore.postman_environment.json` | Shared by both. `base_url` preset, everything else empty. |
| `legiscore-api-guide.md` | The 13-section written guide: flow, auth, every endpoint, webhooks, payload mapping, errors. |

## Getting going

1. Postman, **Import**, drop in both collections and the environment.
2. Pick the **LegiScore (production)** environment, top right, and paste your `lsk_` key into
   `api_key`. It is typed `secret`, so Postman masks it and leaves it out of anything you export.
3. Work down the guided collection: **0 Pre-flight**, **1 Upload**, **2a Straight-through**,
   **3 Poll status**, **8 Get the report**.

The requests chain themselves. Presign captures `upload_url` and `object_name`, complete captures
`document_id`, create captures `case_id`, and every later request reads them back. You never copy
an id by hand, and the test scripts fail loudly when a step did not return what the next one needs.

Folders 4, 5 and 6 are the three review checkpoints. You only need them when you leave the
`enable*Review` flags on, which is the default. A run with them on waits for you indefinitely:
there is no timeout and no auto-proceed.

## Two collections, on purpose

The same split as the SDKs, where the method surface is generated and the helpers are written by
hand. The guided collection teaches the flow and is worth its maintenance; the reference collection
is free and complete:

```bash
cd spec && python3 build_postman.py            # rewrite the reference collection
cd spec && python3 build_postman.py --check    # fail if it is stale
```

Do not hand-edit the reference collection. Add or change an endpoint in `spec/build_spec.py`,
rebuild the spec, then rerun `build_postman.py` alongside `generate_clients.py`.

Prefer another tool? Insomnia, Bruno and Hoppscotch all import `spec/legiscore-openapi.json`
directly. The reference collection exists only because that import leaves auth and variables for
you to wire up yourself.

## Collections ship empty

**Never commit a key, and never commit a real id.** Everything a partner has to fill in — `api_key`,
`document_id`, `case_id`, `documentId`, `upload_url`, `object_name` — ships blank and stays blank,
and every example property, reference and loan id in these files is invented.

A Postman export made against a live account carries both: the key you were using and the ids of
whatever you touched. Exporting one over these files is how a credential and another customer's
document id end up in a public repository, so re-export nothing here — edit the committed file
instead. CI enforces it: the hygiene job fails on any populated secret-shaped value, and on any
UUID-shaped value anywhere in `integrations/**/*.json`.
