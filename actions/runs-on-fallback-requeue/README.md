# runs-on-fallback-requeue

The second half of
[`runs-on-fallback-watch-queue`](../runs-on-fallback-watch-queue). It waits for
the run the watcher cancelled to finish cancelling, then reruns all of it, so
runs-on-fallback chooses a runner again.

It reruns only a cancelled run of `workflow-path`, and fails on any other
workflow. It leaves the run alone when a newer run of the same branch,
repository and event has replaced it, since rerunning the older one could
cancel the newer one through a concurrency group. A fork's branch with the same
name does not count.

## Usage

The workflow the watcher's `requeue-workflow` names, kept on the default branch:

```yaml
name: CI Requeue

on:
  workflow_dispatch:
    inputs:
      run-id:
        description: ID of the cancelled run to run again.
        required: true
        type: string

concurrency:
  group: ci-requeue-${{ inputs.run-id }}

permissions:
  actions: write

jobs:
  requeue:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: TrogonStack/github-actions/actions/runs-on-fallback-requeue@<sha> # runs-on-fallback-requeue@vX.Y.Z
        with:
          run-id: ${{ inputs.run-id }}
          workflow-path: .github/workflows/ci.yml
          finish-timeout-seconds: 600
```

Anyone who can dispatch it can already rerun the workflow by hand, so it grants
nothing new.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `run-id` | required | The cancelled run. |
| `workflow-path` | required | The only workflow it requeues. |
| `finish-timeout-seconds` | required | How long to wait for the run to finish cancelling. |
| `github-token` | `github.token` | Needs `actions: write`. |

## Outputs

| Output | |
| --- | --- |
| `reason` | `requeued`, `not-cancelled` or `replaced-by-newer-run`. |
