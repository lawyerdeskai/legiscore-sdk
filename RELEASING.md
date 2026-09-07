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

Both registries publish only from the tag through the release workflow, after a reviewer
approves the `release` environment.

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
