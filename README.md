# github-actions

**The one place [TrogonStack][trogonstack] and [straw-hat-team][straw-hat-team]
keep the checks every repository runs.** One copy of each check, versioned, so
that fixing it once fixes it everywhere.

**Each check ships as a composite action with its opinions already decided.** An
action here wraps a maintained upstream tool, pins it to a commit, and fixes its
configuration so consumers inherit a decision rather than repeat it. Only the
settings that genuinely differ between repositories are left as inputs.

**It exists because a check drifts the moment it is copied.** Conventional
commit validation was enforced across fifteen repositories by four separate
implementations that had quietly stopped agreeing on which types were allowed,
which is the same as not enforcing it at all. A single implementation means one
change reaches every consumer instead of fifteen edits nobody finishes.

**It is for maintainers of repositories in either organization**, and for anyone
setting a new one up who would rather inherit the conventions than rediscover
them. Nothing here is specific to either organization's private work, so an
action is equally usable from a public repository.

| Action | Purpose |
| --- | --- |
| [`semconv/pull-request`](actions/semconv/pull-request) | Fails a pull request whose title is not a Conventional Commit |

Each action documents its own inputs and usage in its `README.md`. Versions are
per action, tagged `<component>@vX.Y.Z`, with a `CHANGELOG.md` next to the
`action.yml`.

To work on this repository, run `mise run github:actions:ci:lint`.

[trogonstack]: https://github.com/TrogonStack
[straw-hat-team]: https://github.com/straw-hat-team
