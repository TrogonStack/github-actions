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

## Using an action

```yaml
- uses: TrogonStack/github-actions/actions/semconv/pull-request@<full-sha> # semconv-pull-request@v0.0.1
```

The reference must be a full commit SHA. Both organizations set
`sha_pinning_required`, so a branch or tag reference makes the job refuse to
start rather than fail. Put the release it belongs to in a trailing comment so
the pin is readable, and let Dependabot move it.

## Versioning

Every action carries its own version. A change to one action releases that
action and leaves the others untouched, so a version bump always means
something changed in the thing you pinned.

Tags are `<component>@vX.Y.Z`, for example `semconv-pull-request@v0.0.1`, and
each action keeps its own `CHANGELOG.md` next to its `action.yml`.

Releases are cut by [release-please][release-please] from Conventional Commit
subjects on `main`. `feat` and `fix` produce releases, everything else is a
chore. There is no floating major tag.

Adding an action means adding it to `.github/release-please-config.json` and
`.github/release-please-manifest.json`, or it will never be released.

## Contributing

```sh
mise run github:actions:ci:lint
```

Task files live under `.config/mise/tasks/` on a path mirroring the workflow
that calls them, so CI and a local run are the same command.

[trogonstack]: https://github.com/TrogonStack
[straw-hat-team]: https://github.com/straw-hat-team
[release-please]: https://github.com/googleapis/release-please
