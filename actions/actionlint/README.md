# actionlint

Lints GitHub Actions workflows with [rhysd/actionlint][actionlint] and annotates
the diff with what it finds. The binary is downloaded and checksum-verified at
run time rather than vendored, so a workflow always lints against the version
this action declares.

[actionlint]: https://github.com/rhysd/actionlint

## Usage

Put the lint job in a workflow of its own:

```yaml
# .github/workflows/workflow-lint.yml
name: Workflow lint

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  actionlint:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: TrogonStack/github-actions/actions/actionlint@<sha> # vX.Y.Z
```

It has to be its own workflow file, not a job folded into one of the workflows
it checks. A workflow file that fails to parse runs no jobs at all, so a lint
job defined inside the very file it is meant to guard never gets scheduled,
and the broken file reports no checks rather than a failing one. A separate
file keeps parsing and linting independent: `workflow-lint.yml` can fail
`ci.yml` even when `ci.yml` itself cannot be parsed.

The caller checks out the repository; this action does not, so it can run
against whatever ref the caller already has checked out. Pass
`persist-credentials: false` on that checkout, since nothing after it needs to
push or authenticate as the job.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `1.7.12` | actionlint version to install, without the leading `v`. |
| `shellcheck` | `true` | Install shellcheck so actionlint also lints `run:` scripts. See [Shellcheck](#shellcheck). |
| `config` | empty | Path to an actionlint config file, passed as `-config-file`. Empty lets actionlint auto-discover `.github/actionlint.yaml`. |
| `args` | empty | Extra actionlint arguments, one per line. See [Extra arguments](#extra-arguments). |

## Shellcheck

actionlint lints the shell inside `run:` steps by shelling out to shellcheck,
and silently skips that check when shellcheck is not on `PATH`. A bare
self-hosted runner image does not ship shellcheck the way `ubuntu-latest`
does, so the same workflow would pass on one runner pool and fail on another
for no reason visible in the diff. This action installs a pinned shellcheck
by default so every runner pool sees the same checks; set `shellcheck: false`
only where that duplicates a shellcheck step the caller already runs.

The shellcheck version is not an input. It is pinned to the version this
action's checksums were last computed against, so a caller cannot ask for an
unverified build the way the `config` and `args` inputs would otherwise
allow. Picking up a newer shellcheck means picking up a newer release of this
action.

## Extra arguments

`args` takes one actionlint argument per line, such as:

```yaml
with:
  args: |
    -ignore
    "label \".+\" is unknown"
```

It is newline-separated rather than space-separated because an argument can
itself contain spaces, and splitting on newlines only needs each line read as
one argument, with no word-splitting and no shell evaluation of the line's
contents. Nothing in `args` is interpolated into the step's script; it is
read from an environment variable, so a value with `$(...)`, backticks, or
quotes in it is passed to actionlint literally rather than executed.

## Problem matcher

This action registers actionlint's [problem matcher][problem-matchers] before
running it, so findings on a pull request's changed lines show up as inline
annotations on the diff, not just in the job log. The matcher file is
vendored at [`actionlint-matcher.json`](actionlint-matcher.json) from
[`rhysd/actionlint`'s `.github/actionlint-matcher.json`][matcher-source] at
`v1.7.12`, rather than fetched at run time, so registering it needs no
network call of its own.

[problem-matchers]: https://github.com/rhysd/actionlint/blob/main/docs/usage.md#problem-matchers
[matcher-source]: https://github.com/rhysd/actionlint/blob/v1.7.12/.github/actionlint-matcher.json

## Checksums

Both binaries are downloaded over HTTPS from their project's GitHub releases
and checksummed before anything on `PATH` points at them; a mismatch fails
the step rather than running an unverified binary.

- For the default `version`, the actionlint checksum is one this action
  carries itself, taken from the `actionlint_<version>_checksums.txt` file
  that release published. No extra network call is needed to verify it.
- For any other `version`, this action downloads that release's own
  `actionlint_<version>_checksums.txt` and verifies against it instead,
  because a version it was not pinned against has no local checksum to check
  against.
- shellcheck has no `version` input. Its checksum is pinned the same way the
  default actionlint checksum is, and the only way to move it is a new
  release of this action.

## Supported platforms

Linux on `X64` and `ARM64`, and macOS on `X64` and `ARM64`, read from
`runner.os` and `runner.arch`. Any other combination fails the step with
that pairing named in the error, rather than attempting a download that
cannot exist.

## Fixed behaviour

These are not inputs, on purpose.

- actionlint always runs with no file arguments, from the caller's workspace.
  It discovers `.github/workflows` itself, the same way it would from a
  contributor's own checkout.
- A finding always fails the step. There is no warn-only mode, because a
  lint job that cannot fail is a lint job nobody has to act on.
- This action does not check out the repository and does not depend on mise.
  It installs exactly what it needs to run actionlint, so a caller that
  already manages its own tool versions is not handed a second opinion about
  what Node, Python, or anything else should be.
