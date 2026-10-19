# sticky-comment

Posts a markdown file as a pull request comment, and replaces that comment on
the next run instead of adding another. A run per push leaves one comment that
is always current, rather than a thread a reviewer has to scroll to the bottom
of.

## Usage

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z

      - id: plan
        uses: TrogonStack/github-actions/actions/terragrunt/report@<sha> # vX.Y.Z
        with:
          title: Terraform Plan
          command: terragrunt run --all -- plan -input=false -no-color -lock=false

      - if: ${{ !cancelled() && github.event_name == 'pull_request' }}
        uses: TrogonStack/github-actions/actions/sticky-comment@<sha> # vX.Y.Z
        with:
          path: ${{ steps.plan.outputs.report-path }}
          marker: terraform-plan
```

`!cancelled()` rather than the default, so a failed step still comments. A
missing file skips the step instead of failing it, because the step that writes
it may have failed before it got that far.

### Several comments on one pull request

The marker is the identity of the comment. Give each workflow or job that
comments a marker of its own, such as `staging-plan` and `production-plan`, or the
second replaces the first.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | required | File holding the comment body, posted as it stands. |
| `marker` | required | Identity of the comment, unique within the pull request. Letters and digits, joined by single dots, dashes or underscores. |
| `token` | `github.token` | Reads and writes the comments. Needs `pull-requests: write`. |

## Outputs

| Output | Description |
| --- | --- |
| `comment-id` | ID of the comment created or updated. Empty when the step skipped. |

## Fixed behaviour

These are not inputs, on purpose.

- The marker is written as `<!-- marker -->` on the first line of the body,
  where it does not render.
- Only a comment the token's own account wrote is replaced. A person who quotes
  the marker owns a comment the token cannot edit, and replacing it would fail
  the step.
- A hidden comment is never replaced. Somebody put it away on purpose, so the
  next run posts a new one.
- Each body ends with a link to the run and the short commit SHA it came from,
  so a reader can tell a current comment from a stale one.
- A body over GitHub's limit of 65536 characters is cut, keeping the head, and
  says so. The first lines are the part a reviewer reads. Whatever writes the
  file should budget well under the limit, as `terragrunt/report` does, so this
  is a backstop.
- A run with no pull request behind it, such as a `push`, skips the step.

## Limits

- A pull request from a fork runs with a read-only `github.token`, so the write
  is refused and the step fails.
- Two runs under one marker at the same moment can both find no comment and
  both post one. A `concurrency` group keyed on the pull request prevents that.
