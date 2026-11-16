# github-app-token/gcp

Mints a GitHub App installation token from a private key kept in Google Secret
Manager, read through Workload Identity Federation, so the key never sits in a
GitHub secret.

Nothing about the token is implied. The caller states what a failure does
(`on-failure`, no default) and which permissions the token carries (at least one
`permission-*` input), and the step fails when either is missing.

## Choosing `on-failure`

| Value | When the token cannot be minted | Use it for |
| --- | --- | --- |
| `fail` | The step fails, and so does the job. | A job that cannot do its work without the token: a release, a commit, a comment. |
| `empty-token` | The step succeeds with an empty `token`, and `reason` says which step failed. | A job with something sensible to do without it, such as [`runs-on-fallback`](../../runs-on-fallback) choosing a hosted runner. |

In `empty-token` mode an empty `workload-identity-provider` skips every step
(`not-configured`). Keep the provider in a GitHub environment that only trusted
runs declare: every other run reads it empty and falls through, so the trust
check lives once, on the job's `environment:`, and nowhere else.

A mistake in the calling workflow fails in both modes: an unknown `on-failure`,
no permission asked for, or, outside the `not-configured` case, a missing
required input.

## It reads one secret

This reads the app's key and nothing else. A job that needs other secrets from
Google uses `google-github-actions/auth` and
`google-github-actions/get-secretmanager-secrets` directly. Give each app its own
Workload Identity pool admitting only its own key, so a job holding one app's
token cannot read anything else.

## Usage

A release job, which must not run without its token:

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    environment: github-app-releaser
    permissions:
      contents: read
      id-token: write
    steps:
      - id: app
        uses: TrogonStack/github-actions/actions/github-app-token/gcp@<sha> # github-app-token-gcp@vX.Y.Z
        with:
          on-failure: fail
          workload-identity-provider: ${{ vars.RELEASER_WORKLOAD_IDENTITY_PROVIDER }}
          project-id: ${{ vars.RELEASER_PROJECT_ID }}
          private-key-secret: ${{ vars.RELEASER_PRIVATE_KEY_SECRET }}
          app-client-id: ${{ vars.RELEASER_APP_CLIENT_ID }}
          repositories: ${{ github.event.repository.name }}
          permission-contents: write
          permission-pull-requests: write
```

Runner selection, which falls back to hosted runners without it:

```yaml
jobs:
  runner:
    runs-on: ubuntu-latest
    # The only trust check: a run that does not declare the environment reads
    # its variables empty, and an empty provider skips every step below.
    environment: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'github-app-baton' || '' }}
    permissions:
      contents: read
      id-token: write
    outputs:
      runners: ${{ steps.runner.outputs.runners }}
    steps:
      - id: app
        uses: TrogonStack/github-actions/actions/github-app-token/gcp@<sha> # github-app-token-gcp@vX.Y.Z
        with:
          on-failure: empty-token
          workload-identity-provider: ${{ vars.BATON_WORKLOAD_IDENTITY_PROVIDER }}
          project-id: ${{ vars.BATON_PROJECT_ID }}
          private-key-secret: ${{ vars.BATON_PRIVATE_KEY_SECRET }}
          app-client-id: ${{ vars.BATON_APP_CLIENT_ID }}
          permission-organization-self-hosted-runners: read

      - id: runner
        uses: TrogonStack/github-actions/actions/runs-on-fallback@<sha> # runs-on-fallback@vX.Y.Z
        with:
          github-token: ${{ steps.app.outputs.token }}
          primary-labels: ${{ vars.SELF_HOSTED_RUNNER_LABELS }}
          scope: organization
```

The job needs `id-token: write` for the federated login. An action cannot ask
for it, nor declare the environment, so both stay on the calling job.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `on-failure` | none, required | `fail` or `empty-token`, described above. |
| `workload-identity-provider` | none, required | Full provider resource name. Empty is accepted only in `empty-token` mode, as `not-configured`. |
| `project-id` | none, required | Project to authenticate against. A federated identity usually cannot look one up. |
| `private-key-secret` | none, required | Secret holding the key, as `project/secret`. |
| `app-client-id` | none, required | The app's client ID. |
| `owner` | the repository owner | Account the app is installed on. |
| `repositories` | every repository the installation reaches | Repositories under `owner` to limit the token to. |
| `permission-*` | none | Every permission input of `actions/create-github-app-token` v3.3.0, passed through unchanged. At least one is required. |

Without a single permission asked for, GitHub would grant the token every
permission the installation holds. That is never what a caller should get by
leaving something out, so the step refuses.

## Outputs

| Output | |
| --- | --- |
| `token` | The installation token, masked in logs. Empty only in `empty-token` mode, when minting failed or was skipped. |
| `reason` | `empty-token` mode only: `minted`, `not-configured`, `auth-failed`, `key-failed` or `token-failed`, also written to the step summary. |

The token is revoked when the job ends.
