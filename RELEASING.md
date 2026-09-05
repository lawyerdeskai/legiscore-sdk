# Releasing

Both packages ship from one tag, so their versions cannot drift apart. Nothing publishes
without passing the full CI suite against the exact tagged commit.

```bash
# 1. bump BOTH versions to the same number
#    python/pyproject.toml  ->  version = "0.2.0"
#    node/package.json      ->  "version": "0.2.0"
# 2. commit, then tag
git tag v0.2.0 && git push origin main --tags
```

The `Release` workflow then refuses to continue unless the tag and both package versions agree,
re-runs every CI check, and only then publishes to PyPI and npm.

## One-time setup, before the first release

**These need a browser and your credentials. I cannot do them, and no automation should hold the
credentials that could.**

### 1. Make the repository public — before the first tag

Do this first, not last. The package metadata points at this repository, and npm provenance
attests to a public commit: publishing while the repository is private ships links that resolve to
a 404 and cannot be corrected in place, because a published version is immutable.

### 2. Turn on 2FA on both registries

- PyPI: Account settings, Two factor authentication.
- npm: Account settings, Two-factor authentication, "Require two-factor authentication".

Do this **before** the first publish. Afterwards the account already owns a package, and an
account takeover is a supply-chain compromise rather than an inconvenience.

### 3. Create the `@legiscore` npm organisation

`@legiscore/sdk` is a scoped name, and the scope has to exist before anything can be published
into it. The npm account is `lawyerdeskai`, so the scope is not a personal one: create an
**organisation** named `legiscore` (npmjs.com, Add organization — the Free plan publishes public
packages), then add the publishing account as an owner. Without this, the first publish fails with
a 404 on the scope rather than anything that names the real problem.

### 4. Publish the first npm version manually, then configure trusted publishing

This is the ordering that surprises people. On npm, a trusted publisher is configured **on the
package**: npmjs.com → Packages → *your package* → Settings → Trusted publishing
(<https://docs.npmjs.com/trusted-publishers>). There is no pending-publisher concept the way PyPI
has one, so the package has to exist before the trusted publisher can be attached to it.

So the very first npm release is manual, from a clean clone, on a machine with 2FA:

```bash
git clone https://github.com/lawyerdeskai/legiscore-sdk && cd legiscore-sdk/node
npm ci && npm run build
npm publish --access public        # NOT --provenance: provenance needs a CI OIDC token
```

`--provenance` cannot be produced locally, so the first version ships without it; every version
after this one gets it from the workflow. Then attach the trusted publisher with:

- Owner `lawyerdeskai`, repository `legiscore-sdk`, workflow `release.yml`, environment `release`.

PyPI is the easy half: it supports a **pending publisher**, so the very first release can go
through the workflow. Your projects → Publishing → Add a new pending publisher, with the same four
values.

After this, no registry token exists in this repository's secrets, and none should ever be added.
A long-lived token is the thing that gets stolen and used to publish a backdoored version in our
name; trusted publishing replaces it with a short-lived OIDC exchange that only works from this
repository's workflow, in the `release` environment.

Two version floors make OIDC work, and the release workflow already handles both: npm CLI
**11.5.1 or later** (hence `npm install -g npm@latest` before the publish step) and Node
**22.14.0 or higher** (hence Node 22 in the job). Under trusted publishing npm attaches provenance
by default; the workflow passes `--provenance` anyway so the intent is visible in the log.

### 5. Create the `release` environment on GitHub

Settings, Environments, New environment, named `release` exactly. Add yourself as a **required
reviewer**. That turns publication into something a human approves in the moment, which is worth
having on an action that cannot be undone.

### 6. Protect `main`

Once the repository is public, turn on: require the CI checks (`python (3.10)`, `python (3.12)`,
`python (3.14)`, `node (20)`, `node (22)`, `views (20)`, `views (22)`, `hygiene`,
`package-contents`, `generated-artefacts`), require a pull request, and forbid force-pushes and
deletions. Until then the `release` environment reviewer is the real gate, because it is the one
that stands between a mistake and a permanent publication.

### 7. Decide the names

Publishing claims `legiscore` on PyPI and `@legiscore/sdk` on npm permanently, and a published
version should be assumed copied even if you unpublish it. Confirm both names are what you want
before the first release, not after.

## What the pipeline enforces on every run

| Check | Why |
|---|---|
| Python 3.10, 3.12 and 3.14; Node 20 and 22 | 3.10 and Node 20 are the floors we advertise; the newest is what a partner starting today will use |
| `mypy --strict` and `ruff` on the Python package | The types are part of the contract, not a comment |
| `npm run check` on the Node package | Type-checks the published surface, ESM and CJS both |
| Version parity between the two packages | A partner on Python and a partner on Node must get the same behaviour from the same version |
| The publication denylist, over the whole tree | One list, in `spec/sanitize_spec.py`, run by `build_spec.py --scan`. Infrastructure names, internal modules, permission strings and customer data are all a failed build |
| No credentials, and no real ids in `integrations/**/*.json` | Assume anything published has been copied. A UUID-shaped value in a collection is customer data even though it is not credential-shaped |
| `build_spec.py --check` and `build_postman.py --check` | The spec and the reference collection are generated. A hand-edit that reintroduces a description fails here |
| npm tarball contents | Build output and docs only, never source, tests or config |
| PyPI sdist contents plus `twine check` | Same, and the metadata has to render |

## Version numbers

Patch for a fix, minor for new methods or a new module, major for a change that breaks a caller.
The SDK's major version tracks the API's: `legiscore 1.x` speaks API v1. Do not release a `1.0.0`
until the API surface it wraps is versioned and stable, because 1.0.0 is a promise about
compatibility that we would then have to keep.
