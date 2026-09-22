# runs-on-selector

Resolves the runner label a run's jobs should schedule on, from a label on the
pull request and a pool map the caller owns. A maintainer moves a single pull
request onto other hardware by adding one label, and nothing else changes.

`runs-on` is resolved before a job exists, and [the contexts it accepts][contexts]
are `github`, `needs`, `strategy`, `matrix`, `vars` and `inputs`. `steps` is not
among them, so no action can set the `runs-on` of the job it runs in. This one
goes in a job of its own and the jobs that care read its output through `needs`.

[contexts]: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts

## Usage

The map is an input, so this needs no checkout, no token, and no permissions.

```yaml
name: CI

on:
  pull_request:

permissions: {}

jobs:
  runner:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      runs-on: ${{ steps.pick.outputs.runs-on }}
    steps:
      - id: pick
        uses: TrogonStack/github-actions/actions/runs-on-selector@<sha> # vX.Y.Z
        with:
          default-pool-name: github
          pools-json: |
            {
              "github": "ubuntu-24.04",
              "github-arm": "ubuntu-24.04-arm",
              "fleet": "acme-ci-linux-x64"
            }

  test:
    needs: runner
    runs-on: ${{ needs.runner.outputs.runs-on }}
    steps:
      - run: echo test
```

`needs: runner` is not optional on a job that reads the output. A job that reads
it without waiting for it gets an empty string, and an empty `runs-on` is a job
queued against no pool: no error, no runner, forever.

The resolver job's own `runs-on` is a literal and has to be. It is the job that
resolves a pool, so it cannot resolve its own.

Every other job now waits on a runner boot, a few seconds, serialized in front
of work that used to start at once.

## One copy of the map

Written as above the map is repeated in every workflow, which is the drift this
exists to remove. Put the resolver job in a reusable workflow of your own, with
the `pools-json` above, and call it:

```yaml
jobs:
  runner:
    uses: ./.github/workflows/runner.yml

  test:
    needs: runner
    runs-on: ${{ needs.runner.outputs.runs-on }}
```

A local reusable workflow resolves from the ref with no checkout. Wrapping it in
a local *action* instead (`./.github/actions/runner`) does not: a local action
ref is read from the workspace, so every resolver job would need a checkout.

## Labels

A pool named `fleet` is asked for with the label `runs-on:fleet`, which names
the workflow key it ends up controlling. That half is `label-prefix`, and it is
worth leaving alone: one vocabulary across repositories is the point of shipping
this once. Change it where those labels are already spoken for.

The suffix is a pool name, not a runner label. `runs-on:fleet` asks for the
pool `fleet`, which `pools-json` maps to whatever runner label that pool
schedules on.

The labels are not created for you, because the pools they name are yours.
Create one per pool so they are available in the label picker, and skip the
`default-pool-name` pool if you would rather nobody asked for it by name.

| On the run | Result |
| --- | --- |
| No `runs-on:*` label | `default-pool-name`. Covers `push`, `schedule`, `workflow_run` and `workflow_dispatch`, none of which carry a pull request. |
| One `runs-on:*` label | That pool. |
| Two different ones | Fails. Picking in a fixed order would make the answer depend on the order pools happen to be written in. |
| A pool that is not in `pools-json` | Fails, listing the ones that are. |

Because every job reads the same output, one label moves the whole run, which is
what keeps caches warm: `actions/cache` and any vendor's cache proxy are local to
the fleet that wrote them. A job that belongs elsewhere writes its own literal
`runs-on` and ignores the output.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `pools-json` | required | JSON object mapping pool names to the single runner label each schedules on. A pool name is lowercase letters, digits and dashes, because it is half of a GitHub label. |
| `default-pool-name` | required | Pool to use when no `runs-on:*` label asks for one. Must name one of `pools-json`. An expression here covers events that carry no labels at all, such as a `workflow_dispatch` pool picker. |
| `label-prefix` | `runs-on` | Prefix of the labels this reads, without the colon. Change it only where `runs-on` collides with labels already in use. |

The step logs which of the two decided, so a surprising answer is one grep away.

## Outputs

| Output | Description |
| --- | --- |
| `runs-on` | The runner label the calling workflow's jobs should schedule on, named after the key it feeds. |
| `pool-name` | The name of the pool that label came from. Useful in job names and `if:`. |

## Fixed behaviour

These are not inputs, on purpose.

- The `runs-on:` prefix is the same everywhere. One vocabulary across every
  repository is the reason this ships once rather than being copied.
- A name that does not match a pool fails the run, in a label and in
  `default-pool-name`. Falling back would schedule work on hardware nobody chose and
  report green, which is the failure mode that is expensive to notice.
- `default-pool-name` names one of the pools rather than being a pool of its own, so
  trialling a new default is a one-line edit and the label on the one pull
  request it breaks is already the way out.
- A pool maps to a single runner label, not to the `runs-on` list form. A fleet
  that needs several labels should be given one label of its own, or a runner
  group, so the name a maintainer types stays the name of a decision.

## Forks

A pull request from a fork runs the workflow file from its own head, so a fork
can already write `runs-on` directly or delete the resolver job. This action
changes nothing about that in either direction, and nothing here is a defence
against it.

Where forks and self-hosted hardware meet, the controls are GitHub's: require
approval for fork runs, keep self-hosted pools off public repositories, or use
`pull_request_target`, which runs the base branch's workflow file.
