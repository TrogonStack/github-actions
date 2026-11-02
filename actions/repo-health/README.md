# repo-health

Fails unless the repository keeps the practices every repository is expected to
keep. Every check is on by default. The only way past one is to set that
check's own `<check>-skip` input to the reason, so a repository that does not
meet a practice says so in its workflow rather than by leaving the check out.

## Usage

```yaml
name: Repo health

on:
  pull_request:
  schedule:
    - cron: '0 9 1 * *' # monthly, so a repository that has not changed is still checked
  workflow_dispatch:

permissions: {}

jobs:
  repo-health:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z
        with:
          persist-credentials: false

      - uses: TrogonStack/github-actions/actions/repo-health@<sha> # vX.Y.Z
```

The workflow decides when it runs. The action only reads the checkout, so it
gives the same answer however often it is called.

### Skipping a check

```yaml
      - uses: TrogonStack/github-actions/actions/repo-health@<sha> # vX.Y.Z
        with:
          citation-cff-skip: internal tooling, nothing to cite
```

## Checks

| Check | Passes when |
| --- | --- |
| `citation-cff` | `CITATION.cff` sits at the repository root under that exact name, with the top-level keys CFF 1.2.0 requires: `cff-version`, `message`, `title`, `authors`. |

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `directory` | `github.workspace` | Root of the checked-out repository. |
| `citation-cff-skip` | empty | Reason to skip `citation-cff`. Empty runs it. |

## Outputs

| Output | Description |
| --- | --- |
| `failed` | JSON array of the checks that failed and were not skipped. |

## Fixed behaviour

These are not inputs, on purpose.

- Every check runs unless skipped. A check added in a later version applies to
  every consumer as they upgrade, which is the point of keeping them here.
- Each check has its own inputs, named `<check>-<option>`, rather than one
  shared list. A misspelled input is then flagged by actionlint and by the
  runner instead of quietly switching nothing off.
- A skip set to a bare `true` or `false` fails the step. The value is the
  reason, because a waiver that does not say why cannot be reviewed.
- A skipped check still runs. While it fails, its reason is printed as a
  warning. Once it passes, the warning asks for the skip to be removed.
- `citation-cff` checks top-level keys, not the full CFF schema. A schema
  validator is a dependency, and a dependency here means a bundler and a
  committed `dist/`.
