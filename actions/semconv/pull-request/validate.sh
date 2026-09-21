#!/usr/bin/env bash
# Validates a pull request title and its commit subjects against Conventional
# Commits.
#
# SECURITY: this script reads the pull request only through the API. It never
# checks out, builds, or executes pull request content, which is what makes it
# safe to run from pull_request_target. Do not add a checkout or install step
# to the calling job.

set -euo pipefail

# shellcheck source=../lib/conventional.sh source-path=SCRIPTDIR
. "${GITHUB_ACTION_PATH}/../lib/conventional.sh"

types=${SEMCONV_TYPES:?types input is required}
subject_pattern=${SEMCONV_SUBJECT_PATTERN-}
validate_title=${SEMCONV_VALIDATE_TITLE:-true}
validate_commits=${SEMCONV_VALIDATE_COMMITS:-true}

# Every input falls back to the triggering event, so the common case needs no
# `with:` block. This reads the same under pull_request and pull_request_target.
from_event() {
  [ -r "${GITHUB_EVENT_PATH:-}" ] || return 0
  jq -r "$1 // empty" "$GITHUB_EVENT_PATH"
}

repository=${SEMCONV_REPOSITORY:-${GITHUB_REPOSITORY:-}}
pr_title=${SEMCONV_PR_TITLE:-$(from_event '.pull_request.title')}
pr_number=${SEMCONV_PR_NUMBER:-$(from_event '.pull_request.number')}

if [ -z "$repository" ]; then
  printf '::error::cannot determine the repository\n'
  exit 1
fi

alternation=$(conventional_types_to_alternation "$types")

checked=0
failures=()

check() {
  local label=$1 subject=$2 reason

  checked=$((checked + 1))

  if reason=$(conventional_check_subject "$subject" "$alternation" "$subject_pattern"); then
    printf 'ok      %s: %s\n' "$label" "$subject"
  else
    printf '::error::%s "%s": %s\n' "$label" "$subject" "$reason"
    failures+=("- **${label}** \`${subject}\`: ${reason}")
  fi
}

if [ "$validate_title" = "true" ]; then
  if [ -z "$pr_title" ]; then
    printf '::error::pr-title is empty; pass github.event.pull_request.title\n'
    exit 1
  fi

  check 'title' "$pr_title"
fi

if [ "$validate_commits" = "true" ]; then
  if [ -z "$pr_number" ]; then
    printf '::error::pr-number is required when validate-commits is true\n'
    exit 1
  fi

  # Merge commits are excluded: they are authored by GitHub, not the contributor.
  if ! records=$(gh api --paginate "repos/${repository}/pulls/${pr_number}/commits" \
    --jq '.[] | select((.parents | length) < 2) | [.sha[0:7], (.commit.message | split("\n")[0])] | @tsv'); then
    printf '::error::unable to list pull request commits\n'
    exit 1
  fi

  if [ -z "$records" ]; then
    printf '::error::pull request has no non-merge commits to validate\n'
    exit 1
  fi

  while IFS=$'\t' read -r sha subject; do
    check "$sha" "$subject"
  done <<<"$records"
fi

# Backticks below are markdown for the job summary, not command substitution.
# shellcheck disable=SC2016
{
  printf '## Conventional commits\n\n'
  printf 'Checked %d subject(s). Allowed types: `%s`.\n\n' "$checked" "${alternation//|/, }"

  if [ ${#failures[@]} -eq 0 ]; then
    printf 'Everything is conventional.\n'
  else
    printf '### Not conventional\n\n'
    printf '%s\n' "${failures[@]}"
    printf '\nEvery commit subject and the pull request title must read\n'
    printf '`<type>[(scope)][!]: <description>`. To reword:\n\n'
    printf '```sh\n'
    printf '# the title: edit it in the GitHub UI\n\n'
    printf '# the most recent commit\n'
    printf 'git commit --amend && git push --force-with-lease\n\n'
    printf '# several commits\n'
    printf 'git rebase -i %s && git push --force-with-lease\n' "origin/${GITHUB_BASE_REF:-main}"
    printf '```\n'
  fi
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

[ ${#failures[@]} -eq 0 ]
