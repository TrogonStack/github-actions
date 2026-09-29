# terragrunt-report

Runs a Terragrunt command and turns what it did into a markdown report a
reviewer can read: a table of every unit in the run, and a collapsed diff for
each unit that changes something. The same report goes to a file, ready to post
as a pull request comment, and to the job summary.

A raw Terragrunt log is unreadable as a comment. Every line tofu writes arrives
wrapped in a timestamp, a stream name and a unit prefix, coloured, and
`run --all` interleaves the units besides. This reads Terragrunt's JSON log
instead, which is the same information without the presentation.

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
      - uses: jdx/mise-action@<sha> # vX.Y.Z

      - id: plan
        uses: TrogonStack/github-actions/actions/terragrunt-report@<sha> # vX.Y.Z
        with:
          title: Terraform Plan
          working-directory: terraform
          command: terragrunt run --all -- plan -input=false -no-color -lock=false

      - if: ${{ !cancelled() && steps.plan.outputs.report-path != '' }}
        run: gh pr comment "$PR" --body-file "$REPORT"
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          REPORT: ${{ steps.plan.outputs.report-path }}
```

The action decides how the output is read, and nothing about how Terragrunt is
started. `command` is a shell script, so it can be a task runner's task, a
secret loader wrapping Terragrunt, or a guard that refuses a filter before
anything runs. Credentials, filters and targets stay in the repository that
owns them.

`!cancelled()` rather than the default, so a failed plan still reports. That is
the one a reviewer most needs to read, and the report carries the error text.
Not `always()`: a cancelled run's report is whatever tofu had written when it
was stopped.

### Values from the workflow

Reach anything dynamic through `env` and quote it in the script:

```yaml
      - uses: TrogonStack/github-actions/actions/terragrunt-report@<sha> # vX.Y.Z
        with:
          title: Terraform Plan
          command: terragrunt run --all --filter "$UNIT" -- plan -input=false -no-color
        env:
          UNIT: ${{ inputs.unit }}
```

Writing `${{ inputs.unit }}` into `command` instead expands the expression into
the source of the script before the shell sees it, so a value holding a quote
rewrites the script rather than being read by it.

### Several reports in one job

Every run writes to `report-path`, which defaults to one file under the runner's
temporary directory. Give each run in a job a path of its own, or the second
overwrites the first.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `command` | required | Shell script that runs Terragrunt, executed with `bash -eo pipefail`. |
| `title` | required | Heading of the report. |
| `working-directory` | `.` | Directory the command runs in. |
| `root` | `working-directory` | Directory unit paths are cut against, so a unit reads the way it is written at `--filter`. |
| `preamble` | | Line shown under the heading, before the table. |
| `report-path` | `$RUNNER_TEMP/terragrunt-report.md` | Where the markdown report is written. |
| `summary` | `true` | Whether the report is also appended to the job summary. |

## Outputs

| Output | Description |
| --- | --- |
| `report-path` | The file the report was written to. Empty when rendering failed. |
| `exit-code` | The command's exit status. |

## Fixed behaviour

These are not inputs, on purpose.

- `TG_LOG_FORMAT` is set to `json` for the command, and `TG_LOG_CUSTOM_FORMAT`
  is removed, which would otherwise take precedence. Setting it in the
  environment rather than as a flag reaches Terragrunt through whatever wraps
  it. A command that writes no JSON records at all gets a warning, because an
  empty report is otherwise indistinguishable from a run that did nothing.
- The step's status is the command's. A report that fails to render still fails
  the step, with a warning naming the renderer, so a broken report is never read
  as a broken plan, or the other way round.
- The run log is streamed while the command runs, each line tagged with its
  unit, and is never truncated. The report is budgeted to fit a pull request
  comment: at most 12000 characters per unit and 55000 overall. A unit over its
  budget is cut and says so; a unit past the overall budget keeps its row in
  the table and loses its diff. The job summary and the log still hold all of
  it.
- A unit that left its provider as it found it is a row in a collapsed
  `Unchanged` table, not a diff. It is still listed, because a unit that
  converged and a unit missing from the run are different things.
- A failed unit shows tofu's own diagnostics, falling back to Terragrunt's
  error records when tofu wrote nothing. A unit that failed only because a
  dependency did has a row and nothing else, and the line above the table says
  so. A run that failed before any unit started, on a root configuration
  Terragrunt could not read, shows the run's own error instead of a table.
- The state lock, the refresh of every existing resource and the trailer tofu
  prints without `-out` are dropped from each diff. What an apply created,
  changed or destroyed is kept.
- Cancelling the job forwards the signal to the command's whole process group,
  so tofu can release its state lock rather than leaving one the next run fails
  on.

A plan that runs on pull requests is best run with `-lock=false`. A plan writes
no state, and a cancellation that outlasts the runner's grace period ends tofu
before it can release a lock it holds.
