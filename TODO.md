# Pending

Open items on this repo, newest context first. Anything requiring a decision says whose.

## Blocked on a person, not on code

### Publish to PyPI and npm — **the account owner**
Nothing is published yet. Publishing claims `legiscore` and `@legiscore/sdk` **permanently**, and a
published version should be assumed copied even if unpublished afterwards.

`RELEASING.md` has the setup steps that need a browser and 2FA, and they are cheaper before the
first release than after:
1. 2FA on both registries.
2. The `@legiscore` npm organisation created, so the scope exists.
3. Trusted publishing configured on both, so no registry token exists to steal.
4. The `release` GitHub environment created, with a required reviewer — that reviewer is the only
   human gate on an action that cannot be undone.
5. Confirm the two package names are the ones we want forever.

### Branch protection — **the account owner**
Turn it on once the repository is public: require the CI checks, require a pull request, and forbid
force-pushes and deletions on `main`. `RELEASING.md` lists exactly what to switch on.

## Waiting on the API

### Typed responses
Requests are fully typed from the schema; several partner **responses** are not, because those
routes declare no response model. Declaring them would type both clients for free. It filters live
responses though, so each one needs its real payload compared against the proposed model first —
a field a caller reads but the model omits disappears silently.

### Callbacks beyond the case lifecycle
Only reports push events. Search, translate and extraction are poll-only, so a partner running a
few hundred searches a month writes a polling loop for work whose completion we already know about.
API change first, SDK second.

### Title search is not on the partner surface — **the API owner**
The partner surface is legal opinion reports, raw search, translation, extraction and webhooks.
Title search is not in `PARTNER_OPERATIONS`, so no SDK method, spec path or Postman request offers
it, and `search` is raw search only: 7 operations, 38 across all six modules. Whether and when it
joins is an API decision, not a packaging one; the internal list carries what has to change first.

### Three catalogue events are not emitted yet
`asset.created`, `report.auto_triggered` and `report.started` exist as event keys but nothing sends
them. Both SDKs list them as valid subscriptions. Either start emitting them or drop them from the
catalogue, so a partner cannot subscribe to silence.

## Housekeeping

### `views` joins the version rule if it ever publishes
`views/package.json` is `private: true`, so it publishes nothing and sits outside the one-tag rule.
CI already fails the build if it loses `private: true` without joining the version check, so this
cannot drift quietly — but if it is meant to ship, it joins the tag and the parity gate.

### Curated descriptions are the only descriptions
`spec/descriptions.json` is the sole source of partner-facing prose in the published spec:
`spec/build_spec.py` drops everything else before writing. An operation added to
`PARTNER_OPERATIONS` without an entry there ships with no description at all, which the build says
out loud. Fill it in rather than letting it ship bare.
