# github-app-token/gcp

Mints a GitHub App installation token from a private key kept in Google Secret
Manager, read through Workload Identity Federation, so the key never sits in a
GitHub secret. Any failure gives an empty token rather than a failed job, which
suits a caller that has something sensible to do without one, such as
[`runs-on-fallback`](../../runs-on-fallback) falling back to hosted runners.

It reads exactly one secret, the app's key. A job that needs other secrets from
Google uses `google-github-actions/auth` and
`google-github-actions/get-secretmanager-secrets` directly, and a Workload
Identity pool that admits only this key keeps a job holding the token from
reading anything else.

## Usage

```yaml
jobs:
  runner:
    runs-on: ubuntu-latest
    # The trust check lives here and only here: a run that does not declare the
    # environment reads its variables empty, and an empty provider skips every
    # step of this action.
    environment: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'github-app' || '' }}
    permissions:
      contents: read
      id-token: write
    outputs:
      runners: ${{ steps.runner.outputs.runners }}
    steps:
      - id: app
        uses: TrogonStack/github-actions/actions/github-app-token/gcp@<sha> # github-app-token-gcp@vX.Y.Z
        with:
          workload-identity-provider: ${{ vars.APP_WORKLOAD_IDENTITY_PROVIDER }}
          project-id: ${{ vars.APP_PROJECT_ID }}
          private-key-secret: ${{ vars.APP_PRIVATE_KEY_SECRET }}
          app-client-id: ${{ vars.APP_CLIENT_ID }}
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
| `workload-identity-provider` | | Full provider resource name. Empty skips every step (`not-configured`). |
| `project-id` | | Project to authenticate against. Set it: a federated identity usually cannot look one up. |
| `private-key-secret` | | Secret holding the key, as `project/secret`. |
| `app-client-id` | | The app's client ID. |
| `owner` | the repository owner | Account the app is installed on. |
| `permission-organization-self-hosted-runners` | | `read` or `write`. |

Ask for the permissions the token needs. With none asked for, the token carries
every permission the installation holds. More permission inputs are added as a
caller needs them.

## Outputs

| Output | |
| --- | --- |
| `token` | The installation token, masked in logs, or empty. |
| `reason` | `minted`, `not-configured`, `auth-failed`, `key-failed` or `token-failed`. |

The reason is also written to the step summary. A failed step shows as an error
annotation on the run even though the job succeeds.
