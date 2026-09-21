# semconv/pull-request

Fails a pull request whose title, or any of whose non-merge commit subjects, is
not a Conventional Commit.

## Usage

```yaml
name: SemConv

on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened]

permissions: {}

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: read
    steps:
      # This job must not check out, install, or build pull request content.
      # See "Why pull_request_target" below.
      - uses: TrogonStack/github-actions/actions/semconv/pull-request@<sha> # vX.Y.Z
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `types` | `feat`, `fix`, `chore` | Allowed types, comma or newline separated. Each must be lowercase alphanumeric. |
| `subject-pattern` | `^[^A-Z]` | POSIX ERE the description must match. Empty disables the check. |
| `validate-title` | `true` | Validate the pull request title. |
| `validate-commits` | `true` | Validate every non-merge commit subject. Set to `false` when the repository squash-merges. |
| `pr-number` | from the event | Pull request number. |
| `pr-title` | from the event | Pull request title. |
| `repository` | from the event | Repository as `owner/name`. |
| `token` | `github.token` | Used to list commits. Read access is sufficient. |

## Why `pull_request_target`

Under `pull_request`, the workflow file that runs comes from the pull request
head. A contributor could edit this check to pass unconditionally and satisfy a
required status. `pull_request_target` runs the file from the base branch, so
the check cannot be rewritten by the change it is checking.

That trigger is normally dangerous because it grants a writable token to a job
that might build untrusted code. This action never checks out, installs, or
executes pull request content: it reads the title from the event payload and the
commit subjects from the API. Keep it that way. If the job ever needs to build
something, split that into a separate `pull_request` workflow.

## Grammar

```
<type>[(scope)][!]: <description>
```

Merge commits are skipped; they are authored by GitHub rather than the
contributor. A pull request with no non-merge commits fails.
