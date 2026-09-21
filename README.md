# github-actions

Shared GitHub Actions for [TrogonStack][trogonstack] and
[straw-hat-team][straw-hat-team].

| Action | Purpose |
| --- | --- |
| [`semconv/pull-request`](actions/semconv/pull-request) | Fails a pull request whose title is not a Conventional Commit |

## Using an action

```yaml
- uses: TrogonStack/github-actions/actions/semconv/pull-request@<full-sha> # v0.1.0
```

The reference must be a full commit SHA. Both organizations set
`sha_pinning_required`, so a branch or tag reference makes the job refuse to
start rather than fail. Put the release it belongs to in a trailing comment so
the pin is readable, and let Dependabot move it.

## Versioning

One version covers the whole repository. A release that only touches one action
still bumps the number every consumer sees, which costs nothing: consumers pin
SHAs, so nothing changes for them until they choose to move.

Releases are cut by [release-please][release-please] from Conventional Commit
subjects on `main`. `feat` and `fix` produce releases, everything else is a
chore. There is no floating major tag.

## Contributing

```sh
mise run github:actions:ci:lint
```

Task files live under `.config/mise/tasks/` on a path mirroring the workflow
that calls them, so CI and a local run are the same command.

[trogonstack]: https://github.com/TrogonStack
[straw-hat-team]: https://github.com/straw-hat-team
[release-please]: https://github.com/googleapis/release-please
