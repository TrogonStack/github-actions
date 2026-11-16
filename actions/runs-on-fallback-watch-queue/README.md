# runs-on-fallback-watch-queue

[`runs-on-fallback`](../runs-on-fallback) sends a job to a self-hosted runner it
saw idle, but nothing reserves that runner. Another run can take it first, and
if every self-hosted runner then goes offline, GitHub keeps the job queued for
up to 24 hours. This watches that job from a hosted runner and, past a time
limit still queued, dispatches a requeue workflow and cancels the run. The
requeue workflow runs [`runs-on-fallback-requeue`](../runs-on-fallback-requeue),
which reruns the whole run once it has finished cancelling, so runs-on-fallback
chooses again and picks the hosted fallback when no self-hosted runner is idle.

A run cannot rerun itself while it is being cancelled, which is why the rerun
lives in a separate workflow. It is dispatched on the default branch, so only
that branch's copy of it ever runs.

It exits as soon as the job has a runner, so in the usual case it costs one
short hosted job. A failed status read keeps it watching: it never cancels on
a status it could not read. On attempt `max-run-attempts` it cancels without a
requeue and leaves an error, so a pool that stays down cannot requeue forever.

## Usage

```yaml
jobs:
  runner:
    # runs-on-fallback, with self-hosted-count among its outputs.

  verify:
    needs: runner
    runs-on: ${{ fromJSON(needs.runner.outputs.runs-on-by-job).verify }}

  watch-verify-queue:
    needs: runner
    if: ${{ needs.runner.outputs.self-hosted-count != '0' }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      actions: write
    steps:
      - uses: TrogonStack/github-actions/actions/runs-on-fallback-watch-queue@<sha> # runs-on-fallback-watch-queue@vX.Y.Z
        with:
          job-name: verify
          queue-limit-seconds: 1200
          max-run-attempts: 3
          requeue-workflow: ci-requeue.yml
```

Set `timeout-minutes` above `queue-limit-seconds`. Leave this job out of any
result gate: it succeeds whether or not it requeued.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `job-name` | required | Job to watch, as the jobs API names it. |
| `queue-limit-seconds` | required | How long the job may wait for a runner. |
| `max-run-attempts` | required | The attempt on which it cancels without a requeue. |
| `requeue-workflow` | required | File name of the workflow that runs `runs-on-fallback-requeue`. |
| `github-token` | `github.token` | Needs `actions: write`. |
