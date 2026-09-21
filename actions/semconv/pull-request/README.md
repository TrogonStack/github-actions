# semconv/pull-request

Fails a pull request whose title is not a Conventional Commit. A thin wrapper
around [`amannn/action-semantic-pull-request`][upstream] that fixes the grammar
so every repository agrees on it.

## Usage

The job name matters. Repository rulesets require the check by the literal
string `Validate PR Title`, so renaming the job silently stops the required
check from ever reporting.

```yaml
name: SemConv

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions: {}

jobs:
  lint-pr-title:
    name: Validate PR Title
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: read
    steps:
      - uses: TrogonStack/github-actions/actions/semconv/pull-request@<full-sha>
```

The reference must be a full commit SHA. Both organizations set
`sha_pinning_required`, so a branch or tag reference makes the job refuse to
start rather than fail.

## Grammar

```
<type>[(scope)][!]: <description>
```

`feat`, `fix`, and `chore` are the only types. Anything that is not a feature or
a fix is a chore. The description must not start with an uppercase letter.

The type list is not an input. One grammar for every repository is the reason
this action exists; a knob invites back the divergence it was built to remove.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `extra-ignore-labels` | none | Further labels that skip the check, one per line. |
| `token` | `github.token` | Read access is sufficient. |

`bot`, `dependencies`, and `autorelease: pending` are always ignored. The last
is release-please's own pull request, which does not follow the grammar it
exists to produce.

## Title only

Only the title is checked, because only the title reaches the default branch on
a squash merge. Repositories that allow merge or rebase commits, or that squash
with `COMMIT_OR_PR_TITLE`, can still land an unconventional subject. That is a
repository settings problem and is fixed in the Terraform that owns those
settings, not here.

[upstream]: https://github.com/amannn/action-semantic-pull-request
