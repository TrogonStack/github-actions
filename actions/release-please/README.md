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

The action validates configuration from the checkout before release-please
fetches it from the branch over the API. Check out the repository before using
the action. The configuration and manifest paths are fixed:

```
.github/release-please-config.json
.github/release-please-manifest.json
```

Those paths are not inputs. One location for every repository is the reason
this action exists; a knob invites back the drift it was built to remove.

Use this configuration as a starting point. Adapt `packages`, the release type,
tag formatting, changelog sections and plugins to the repository:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "simple",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": false,
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

### Validation policy

The action validates these release settings for every package. They must
resolve to `false`:

- `bump-patch-for-minor-pre-major`
- `draft`
- `draft-pull-request`
- `prerelease`

`include-v-in-tag` must resolve to `true` for every package.

Package overrides take precedence over top-level settings. Validation checks
each package's effective value, so an override can satisfy the policy even
when the top-level value differs. Omitted settings use release-please's native
defaults: `false` for the settings above and `true` for `include-v-in-tag`.
Explicit values must be booleans; `null` and strings are rejected. A top-level,
nonempty `signoff` is required.

Other boolean settings are checked for their types, without forcing a shared
value. Settings such as `bump-minor-pre-major`, tag formatting, `release-type`
and plugins remain repository-specific.

Every package must set `initial-version`, or the configuration must set one at
the top level, because without it release-please chooses the first version on
its own. `require-initial-version: false` disables only this requirement.
Checkout validation, the shared field policy and mandatory sign-off still
apply.

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
| `require-initial-version` | `true` | Requires an `initial-version` for every package. Disabling it does not bypass other configuration validation. |

[release-please]: https://github.com/googleapis/release-please
