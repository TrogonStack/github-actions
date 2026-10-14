# jactionlint

Lints GitHub Actions workflows, composite actions and Dependabot config with
[jdx/jactionlint][jactionlint] and annotates the diff with what it finds. The
binary is downloaded and checksum-verified at run time rather than vendored,
so a workflow always lints against the version this action declares.

jactionlint is a fork of [rhysd/actionlint][actionlint] that keeps its
correctness checks and adds security and policy rules on top, such as
untrusted input in scripts, unpinned actions, excessive permissions and
missing concurrency or timeouts. Use this action instead of
[`actionlint`](../actionlint), not next to it: the correctness findings would
be reported twice.

[jactionlint]: https://github.com/jdx/jactionlint
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

concurrency:
  group: workflow-lint-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
  jactionlint:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: TrogonStack/github-actions/actions/jactionlint@<sha> # vX.Y.Z
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
| `version` | `2.1.0` | jactionlint version to install, without the leading `v`. |
| `shellcheck` | `true` | Install shellcheck so jactionlint also lints `run:` scripts. See [Shellcheck](#shellcheck). |
| `config` | empty | Path to a jactionlint config file, passed as `--config-file`. Empty lets jactionlint auto-discover `.github/jactionlint.yaml`. |
| `args` | empty | Extra jactionlint arguments, one per line. See [Extra arguments](#extra-arguments). |

## Adopting it on an existing repository

The `default` profile includes security and policy rules that actionlint never
had, so the first run on an existing repository usually reports findings that
were always there. Fix them, lower or disable a rule in
`.github/jactionlint.yaml`, or record them in a baseline with
`jactionlint --baseline-write` and commit it, so that only new findings fail
the job. Run that locally with the same `version` and shellcheck this action
uses; a finding your machine cannot produce is not recorded, so CI would
report it as new.

## Shellcheck

jactionlint lints the shell inside `run:` steps by shelling out to shellcheck,
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

jactionlint also lints `shell: python` steps with pyflakes when it is on
`PATH`. This action does not install it, because pyflakes is a Python package
rather than a single checksummed binary.

## Extra arguments

`args` takes one jactionlint argument per line, such as:

```yaml
with:
  args: |
    --profile=pedantic
    --ignore=mutable-runner-label
```

It is newline-separated rather than space-separated because an argument can
itself contain spaces, and splitting on newlines only needs each line read as
one argument, with no word-splitting and no shell evaluation of the line's
contents. Nothing in `args` is interpolated into the step's script; it is
read from an environment variable, so a value with `$(...)`, backticks, or
quotes in it is passed to jactionlint literally rather than executed.

jactionlint takes an optional option value only in the `--option=value` form,
so write `--baseline=path` rather than `--baseline` and `path` on separate
lines; the second line would be read as a file to lint.

## Annotations

This action always runs jactionlint with `--format github`, which prints each
finding as a [workflow command][workflow-commands]. GitHub turns those into
inline annotations on the pull request's changed lines, at the level the rule
reports: `error`, `warning` or `notice`. No problem matcher is registered,
because jactionlint emits the annotations itself.

[workflow-commands]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands

## Checksums

Both binaries are downloaded over HTTPS from their project's GitHub releases
and checksummed before anything on `PATH` points at them; a mismatch fails
the step rather than running an unverified binary.

- For the default `version`, the jactionlint checksum is one this action
  carries itself, taken from the `jactionlint_<version>_checksums.txt` file
  that release published. No extra network call is needed to verify it.
- For any other `version`, this action downloads that release's own
  `jactionlint_<version>_checksums.txt` and verifies against it instead,
  because a version it was not pinned against has no local checksum to check
  against.
- shellcheck has no `version` input. Its checksum is pinned the same way the
  default jactionlint checksum is, and the only way to move it is a new
  release of this action.

## Supported platforms

Linux on `X64` and `ARM64`, and macOS on `X64` and `ARM64`, read from
`runner.os` and `runner.arch`. Any other combination fails the step with
that pairing named in the error, rather than attempting a download that
cannot exist.

## Fixed behaviour

These are not inputs, on purpose.

- jactionlint always runs with no file arguments, from the caller's
  workspace. It discovers `.github/workflows` itself, the same way it would
  from a contributor's own checkout.
- Online checks stay off unless the caller turns them on through `args` or
  the config file, so the default run makes no GitHub API calls and needs no
  token.
- An `error` finding always fails the step. `warning` and `notice` findings
  are annotated without failing it, which is jactionlint's own default; pass
  `--strict-exit` in `args` to fail on those too.
- This action does not check out the repository and does not depend on mise.
  It installs exactly what it needs to run jactionlint, so a caller that
  already manages its own tool versions is not handed a second opinion about
  what Node, Python, or anything else should be.
