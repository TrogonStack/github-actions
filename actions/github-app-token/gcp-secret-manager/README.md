# github-app-token/gcp-secret-manager

Mints a GitHub App installation token from a private key kept in Google Secret
Manager, read through Workload Identity Federation, so the key never sits in a
GitHub secret.

Nothing about the token is implied. The caller states what a failure does
(`on-failure`, no default) and which permissions the token carries (a
`permission-*` input), and the step fails when either is missing.

Only the permissions a caller uses today are exposed, currently
`permission-organization-self-hosted-runners`. A new caller adds the one it
needs, with the same name and values as in `actions/create-github-app-token`.

## Choosing `on-failure`

| Value | When the token cannot be minted | Use it for |
| --- | --- | --- |
| `fail-step` | The step fails, and so does the job. | A job that cannot do its work without the token: a release, a commit, a comment. |
| `return-empty-token` | The step succeeds with an empty `token`, and `reason` says which step failed. | A job with something sensible to do without it, such as [`runs-on-fallback`](../../runs-on-fallback) choosing a hosted runner. |

In `return-empty-token` mode an empty `gcp-workload-identity-provider` skips
every step (`skipped-no-gcp-provider`). Keep the provider in a GitHub environment that only trusted
runs declare: every other run reads it empty and falls through, so the trust
check lives once, on the job's `environment:`, and nowhere else.

A mistake in the calling workflow fails in both modes: an unknown `on-failure`,
no permission named, or, outside the `skipped-no-gcp-provider` case, a missing
required input.

## It reads one secret

This reads the app's key and nothing else. A job that needs other secrets from
Google uses `google-github-actions/auth` and
`google-github-actions/get-secretmanager-secrets` directly. Give each app its own
Workload Identity pool admitting only its own key, so a job holding one app's
token cannot read anything else.

## Usage

Runner selection, which falls back to hosted runners without the token:

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
      runs-on-by-job: ${{ steps.runner.outputs.runs-on-by-job }}
    steps:
      - id: app
        uses: TrogonStack/github-actions/actions/github-app-token/gcp-secret-manager@<sha> # github-app-token-gcp-secret-manager@vX.Y.Z
        with:
          on-failure: return-empty-token
          gcp-workload-identity-provider: ${{ vars.BATON_WORKLOAD_IDENTITY_PROVIDER }}
          gcp-project-id: ${{ vars.BATON_PROJECT_ID }}
          gcp-private-key-secret: ${{ vars.BATON_PRIVATE_KEY_SECRET }}
          github-app-client-id: ${{ vars.BATON_APP_CLIENT_ID }}
          permission-organization-self-hosted-runners: read

      - id: runner
        uses: TrogonStack/github-actions/actions/runs-on-fallback@<sha> # runs-on-fallback@vX.Y.Z
        with:
          runner-list-token: ${{ steps.app.outputs.token }}
          self-hosted-labels: ${{ vars.SELF_HOSTED_RUNNER_LABELS }}
          runner-scope: organization
```

The job needs `id-token: write` for the federated login. An action cannot ask
for it, nor declare the environment, so both stay on the calling job.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `on-failure` | none, required | `fail-step` or `return-empty-token`, described above. |
| `gcp-workload-identity-provider` | none, required | Full provider resource name. Empty is accepted only in `return-empty-token` mode, as `skipped-no-gcp-provider`. |
| `gcp-project-id` | none, required | Project to authenticate against. A federated identity usually cannot look one up. |
| `gcp-private-key-secret` | none, required | Secret holding the key, as `project/secret`. |
| `github-app-client-id` | none, required | The GitHub App's client ID. |
| `permission-organization-self-hosted-runners` | none | `read` or `write`, passed to `actions/create-github-app-token` unchanged. |

The token is minted for the repository owner's installation. Without a
permission named, GitHub would grant the token every
permission the installation holds. That is never what a caller should get by
leaving something out, so the step refuses.

## Outputs

| Output | |
| --- | --- |
| `token` | The installation token, masked in logs. Empty only in `return-empty-token` mode, when minting failed or was skipped. |
| `reason` | `return-empty-token` mode only: `minted`, `skipped-no-gcp-provider`, `gcp-auth-failed`, `gcp-secret-read-failed` or `token-mint-failed`, also written to the step summary. |

The token is revoked when the job ends.
