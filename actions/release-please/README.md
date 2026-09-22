# release-please

Cuts releases with [release-please][release-please] from the configuration
every repository shares.

## Usage

```yaml
name: Release Please

on:
  push:
    branches: [main]

permissions: {}

jobs:
  release-please:
    name: Release Please
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@<full-sha>
        with:
          persist-credentials: false
      - uses: TrogonStack/github-actions/actions/release-please@<full-sha>
        with:
          token: ${{ secrets.GH_PAT_RELEASE_PLEASE_ACTION }}
```

The token must be the organization's personal access token rather than
`github.token`, because a tag pushed with `github.token` does not trigger the
workflows that react to a release.

## Configuration

The configuration is a file in your repository, because release-please fetches
it from the branch over the API rather than from the checkout. Where it lives
is fixed:

```
.github/release-please-config.json
.github/release-please-manifest.json
```

Those paths are not inputs. One location for every repository is the reason
this action exists; a knob invites back the drift it was built to remove.

Start a repository from this configuration and change only `packages`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "simple",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "include-component-in-tag": true,
  "include-v-in-tag": true,
  "tag-separator": "@",
  "separate-pull-requests": true,
  "changelog-sections": [
    { "type": "feat", "section": "Features", "hidden": false },
    { "type": "fix", "section": "Bug Fixes", "hidden": false }
  ],
  "packages": {
    ".": { "component": "your-component", "initial-version": "0.0.1" }
  },
  "plugins": [{ "type": "sentence-case" }],
  "draft": false,
  "draft-pull-request": false,
  "prerelease": false,
  "signoff": "SHT Bot <61149376+sht-bot@users.noreply.github.com>"
}
```

The matching manifest starts every package at the sentinel:

```json
{ ".": "0.0.0" }
```

`0.0.0` means "never released" to release-please, which is what makes it honour
`initial-version`. Any other starting value is read as a real previous release
and gets bumped instead, so the first tag skips the version you asked for.

## Outputs

`releases_created`, `paths_released`, `prs_created` and `prs` are the ones a
monorepo reads. `release_created`, `tag_name`, `sha`, `major`, `minor`,
`patch`, `html_url` and `upload_url` are set only when the repository releases
a single package.

Release-please also sets per path outputs named after the path itself. A
composite action cannot forward a name it does not know in advance, so a
monorepo that needs them should read the `paths_released` array instead.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | required | Opens the release pull request and pushes the tag. |

[release-please]: https://github.com/googleapis/release-please
