#!/usr/bin/env bash
set -euo pipefail

repo="${REPO:?}"
run_id="${RUN_ID:?}"
attempt="${RUN_ATTEMPT:?}"
job="${JOB_NAME:?}"
limit="${QUEUE_LIMIT_SECONDS:?}"
max_attempts="${MAX_RUN_ATTEMPTS:?}"
requeue_workflow="${REQUEUE_WORKFLOW:?}"
default_branch="${DEFAULT_BRANCH:?}"

for n in limit max_attempts; do
  [[ "${!n}" =~ ^[1-9][0-9]*$ ]] || { echo "::error::${n//_/-} must be a positive whole number, got '${!n}'."; exit 1; }
done

deadline=$((SECONDS + limit))

# Acts only on a status it read: a failed read keeps watching rather than end
# the watch or cancel a job that may have started, and the deadline is checked
# after a read so the last status seen is current.
while true; do
  if status="$(gh api "repos/${repo}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" \
    --jq ".jobs[] | select(.name == \"${job}\") | .status")"; then
    case "$status" in
      queued | waiting | pending | requested)
        ((SECONDS < deadline)) || break
        ;;
      *)
        echo "${job} is ${status:-not in this attempt}; nothing to watch."
        exit 0
        ;;
    esac
  else
    echo "::warning::Could not read ${job}'s status; trying again."
  fi
  sleep 20
done

if ((attempt >= max_attempts)); then
  echo "::error::${job} waited ${limit}s for a runner on attempt ${attempt} of ${max_attempts}; cancelling without another attempt. Check that the self-hosted runners are online."
else
  echo "::warning::${job} waited ${limit}s for a runner; requeueing the run so it chooses a runner again."
  gh workflow run "$requeue_workflow" --repo "$repo" --ref "$default_branch" -f run-id="$run_id"
fi
gh run cancel "$run_id" --repo "$repo"
