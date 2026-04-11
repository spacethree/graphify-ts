# GitHub repository settings for graphify-ts

This repository now includes versioned open-source scaffolding such as issue forms, a pull request template, `CODEOWNERS`, a CI workflow, `CONTRIBUTING.md`, and `SECURITY.md`.

Some protections still must be configured in GitHub itself because they are repository settings, not tracked files.

## Recommended baseline for `main`

Create a branch protection rule or ruleset targeting `main` with these defaults:

- require a pull request before merging
- block direct pushes to `main`
- require status checks to pass before merging
- require branches to be up to date before merging
- require conversation resolution before merging
- enable automatic deletion of head branches after merge
- prefer **squash merge** for a cleaner public history
- disable merge commits if you want a tighter linear history

After `.github/workflows/ci.yml` runs at least once on GitHub, select the emitted `validate` check as a required status check.

## Review requirements

If you have **2 or more maintainers**, also enable:

- at least 1 approving review
- require review from code owners
- dismiss stale approvals when new commits are pushed

If you are currently the **only maintainer**, start with PR-only flow + required CI checks first. Requiring external approval too early can accidentally lock the repository against legitimate maintenance.

## Security and open-source hygiene

Enable these repository settings when available:

- private vulnerability reporting
- Dependabot alerts
- Dependabot security updates
- secret scanning (if your plan supports it)
- automatic branch deletion after merge

## Suggested labels

Create a small default label set so triage stays simple:

- `bug`
- `feature`
- `docs`
- `parser`
- `ci`
- `security`
- `good first issue`
- `help wanted`

## Release and tag protection

For public releases, consider protecting tags that match release patterns such as:

- `v*`

That helps prevent accidental retagging of published releases.

Use annotated semantic-version tags such as `v0.1.0`.

This repository now also includes `.github/workflows/release.yml`, which runs on `v*` tags and verifies:

- tag format
- `package.json` version alignment
- matching `CHANGELOG.md` heading
- local-equivalent validation steps before creating a GitHub release

For the step-by-step maintainer workflow, see:

- [`docs/maintainers/releases.md`](./releases.md)

## What is already handled in the repo

Committed to the repository:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/ISSUE_TEMPLATE/*`
- `.github/pull_request_template.md`
- `.github/CODEOWNERS`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

These files improve contribution flow, but they do **not** replace GitHub branch protection or rulesets.
