# release-please/config

Fails a repository whose release-please configuration is not where every
repository keeps it:

```
.github/release-please-config.json
.github/release-please-manifest.json
```

## Usage

The action reads the checked out working tree through `git ls-files`, so it
needs a checkout and nothing else.

```yaml
name: CI

on: pull_request

permissions: {}

jobs:
  release-please-config:
    name: Validate Release Please Config
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<full-sha>
        with:
          persist-credentials: false
      - uses: TrogonStack/github-actions/actions/release-please/config@<full-sha>
```

## What it checks

The configuration and the manifest exist at those two paths and parse as JSON.

No other copy is tracked anywhere in the repository. A copy left behind after a
move is worse than never moving, because release-please reads the one the
workflow names and the other rots unnoticed.

Every workflow that runs `release-please-action` passes exactly those two paths
as `config-file` and `manifest-file`. Files in the right place and a workflow
still pointing at the old ones is a repository that has stopped releasing.

A repository that does not use release-please passes without doing anything, so
the action is safe to put in a shared CI workflow.

## Why .github

Both organizations already keep these files in `.github/`, and release-please
never discovers them by convention, the paths are passed explicitly in every
workflow. The location is a house convention, so the only thing worth enforcing
is that it is the same one everywhere.

The leading-dot spelling, `.github/.release-please-config.json`, is rejected on
purpose. The files already sit inside a dot-directory, so the second dot only
hides them from `ls`.

## Inputs

None. One location for every repository is the reason this action exists.
