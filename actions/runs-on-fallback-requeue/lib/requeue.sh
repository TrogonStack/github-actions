#!/usr/bin/env bash
set -euo pipefail

repo="${REPO:?}"
run_id="${RUN_ID:?}"
workflow_path="${WORKFLOW_PATH:?}"
timeout="${FINISH_TIMEOUT_SECONDS:?}"

[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "::error::run-id must be a number, got '${run_id}'."; exit 1; }
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo "::error::finish-timeout-seconds must be a positive whole number, got '${timeout}'."; exit 1; }

finish() {
  echo "reason=$1" >> "$GITHUB_OUTPUT"
  echo "Run ${run_id}: $1" >> "$GITHUB_STEP_SUMMARY"
  exit 0
}

# The watcher cancels the run right after dispatching this, and GitHub reruns
# only a finished run. A failed read counts as not finished yet, so one API
# error does not lose the requeue.
deadline=$((SECONDS + timeout))
until [[ "$(gh api "repos/${repo}/actions/runs/${run_id}" --jq .status || true)" == completed ]]; do
  ((SECONDS < deadline)) || { echo "::error::Run ${run_id} did not finish within ${timeout}s."; exit 1; }
  sleep 15
done

read -r path workflow_id conclusion branch event head_repo created < <(gh api "repos/${repo}/actions/runs/${run_id}" \
  --jq '[.path, .workflow_id, .conclusion, .head_branch, .event, .head_repository.full_name, .created_at] | @tsv')

if [[ "$path" != "$workflow_path" ]]; then
  echo "::error::Run ${run_id} is ${path}, not ${workflow_path}."
  exit 1
fi
[[ "$conclusion" == cancelled ]] || finish not-cancelled

# A newer run of the same branch, repository and event has replaced this one,
# and running this one again could cancel it through a concurrency group. A
# fork's branch of the same name does not count.
newer="$(gh api "repos/${repo}/actions/workflows/${workflow_id}/runs?branch=${branch}&event=${event}&per_page=20" \
  --jq "[.workflow_runs[] | select(.created_at > \"${created}\" and .head_repository.full_name == \"${head_repo}\")] | length")"
((newer == 0)) || finish replaced-by-newer-run

gh run rerun "$run_id" --repo "$repo"
finish requeued
