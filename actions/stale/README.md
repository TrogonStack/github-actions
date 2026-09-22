# stale

Marks issues and pull requests that have gone quiet, then closes them if they
stay quiet. A thin, opinionated wrapper around
[`actions/stale`](https://github.com/actions/stale).

## Usage

The caller owns the schedule.

```yaml
name: Stale

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

permissions: {}

jobs:
  stale:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      actions: write
      issues: write
      pull-requests: write
    steps:
      - uses: TrogonStack/github-actions/actions/stale@<sha> # vX.Y.Z
```

`actions: write` is not optional. Upstream keeps its progress in the Actions
cache so a run capped by `operations-per-run` resumes where the last one
stopped, and managing that cache entry needs the permission. Without it the
cache delete fails with a 403, every run replays the same prefix of the
backlog, and anything past that prefix is never closed.

Run it once with `debug-only: true` before pointing it at a repository with
years of backlog, so the first real run is not a surprise.

## Labels

| Label | Meaning |
| --- | --- |
| `stale:discard` | Applied by this action. Any activity removes it. |
| `stale:keep` | Applied by a human. Exempts the issue or pull request forever. |

Neither label needs to exist beforehand; `stale:discard` is created on first
use. Create `stale:keep` yourself so it is available in the label picker.

The names are not inputs. One vocabulary across every repository is the reason
this action exists, and a rename in one repository is the drift it was built to
remove.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `days-before-stale` | `60` | Days without activity before marking stale. |
| `days-before-close` | `7` | Days after marking before closing. `-1` marks but never closes. |
| `operations-per-run` | `100` | API operations budget for one run. A run that hits the cap resumes from where it stopped. |
| `debug-only` | `false` | Report what would happen and change nothing. |
| `token` | `github.token` | Needs write access to actions, issues, and pull requests. |

## Fixed behaviour

These are not inputs, on purpose.

- The label names are `stale:discard` and `stale:keep` everywhere.
- Activity removes the stale label. Activity is the entire signal the action
  runs on, so it has to be able to clear it.
- Issues close as `not_planned`, which avoids the completed badge on something
  nobody did.
- Anything on a milestone is exempt. Work on a milestone is planned work,
  however quiet it has gone.
- Oldest first, so a capped operations budget is spent on the worst offenders
  rather than on whatever is newest.
- Branches are never deleted. Deleting someone else's branch on a timer is not
  ours to do.

If you need one of these to differ, that is a conversation about the default
rather than an input to add.

## Outputs

| Output | Description |
| --- | --- |
| `staled-issues-prs` | JSON array of what was marked stale this run. |
| `closed-issues-prs` | JSON array of what was closed this run. |

## Messages

Closing is not a verdict, and the posted messages say so. What they ask for
differs by kind, on purpose.

An issue is closed because nobody is building it, so the message asks for a
pull request. It deliberately does not offer "leave a comment" as the way to
revive one: a comment clears the stale label without moving the issue any
closer to done, which is how a backlog gets kept alive without getting
shipped.

A pull request is already the contribution, so the message asks for a commit
instead, and points at `stale:keep` for the case where the hold-up is a review
on our side rather than the author.

Keep that split if you change the wording.

## Bumping

A comment clears the stale label and buys another full cycle, on issues and on
pull requests alike. That is upstream behaviour and it is not configurable:

- `remove-stale-when-updated` controls whether an update removes the label, and
  a comment counts as an update.
- Turning it off does not help. The close gate in `actions/stale` is
  `if (!issueHasCommentsSinceStale && !issueHasUpdateInCloseWindow)`, so any
  human comment after the label blocks closing whatever that option is set to.
- `ignore-pr-updates` measures from `created_at` instead of `updated_at`, which
  would mark every long lived pull request stale no matter how much work it is
  getting.

So a determined bump wins, and the messages say plainly that it is a limitation
rather than the intended path: on a pull request the thing that counts is a
commit, and a bump leaves the work exactly as unfinished as it was.

Making commits the real currency would mean taking the pull request lifecycle
off upstream and measuring it from the head commit date. That is a bigger
change than this action wants to be today.
