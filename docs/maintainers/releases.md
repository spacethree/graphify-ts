# Release process for graphify-ts

This repository treats Git tags as release markers.

## Tag format

Use annotated semantic-version tags in the form:

- `v0.1.0`
- `v0.1.1`
- `v0.2.0-beta.1`

Do not create floating tags such as `latest`.

## Before tagging

Make sure all of the following are true on `main`:

1. `package.json` has the final version.
2. `CHANGELOG.md` includes a matching section like `## [0.1.1]`.
3. The repo passes local verification:

```bash
npm run typecheck
npm run test:run
npm run build
npm pack --dry-run
```

## Creating a release tag

Create an annotated tag and push it:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

## What happens on tag push

The GitHub workflow in `.github/workflows/release.yml` runs automatically for tags matching `v*`.

It will:

- verify the tag format
- verify that the tag matches `package.json` version
- verify that `CHANGELOG.md` contains the matching version heading
- rerun typecheck, tests, build, and `npm pack --dry-run`
- create a GitHub release with generated notes

## npm publishing

npm publishing is still **manual** today.

That is intentional: it avoids coupling every pushed tag to an immediate package publish until you explicitly choose to automate that with an `NPM_TOKEN`-backed workflow.

## Tag protection

In GitHub repository settings, protect the tag pattern:

- `v*`

That helps prevent accidental retagging or force-moving public release tags.

## Recommended order

For the current setup, a simple maintainer-friendly order is:

1. merge the release commit to `main`
2. confirm local verification passes
3. publish to npm if needed
4. create and push the `vX.Y.Z` tag
5. let GitHub create the release entry automatically

If you later automate npm publishing from tags, keep the same version and changelog checks in place.
