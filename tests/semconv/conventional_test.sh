#!/usr/bin/env bash
# Exercises the grammar directly, so the rules are covered without opening a
# pull request against a fixture repository.

set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../../actions/semconv/lib/conventional.sh source-path=SCRIPTDIR
. "$root/actions/semconv/lib/conventional.sh"

pass=0
fail=0
types=$(conventional_types_to_alternation "feat,fix,chore")
pattern='^[^A-Z]'

accepts() {
  local reason
  if reason=$(conventional_check_subject "$1" "$types" "$pattern"); then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  expected accepted: %-40s (%s)\n' "$1" "$reason"
  fi
}

rejects() {
  if conventional_check_subject "$1" "$types" "$pattern" >/dev/null; then
    fail=$((fail + 1))
    printf 'FAIL  expected rejected: %s\n' "$1"
  else
    pass=$((pass + 1))
  fi
}

accepts 'feat: add the thing'
accepts 'fix(parser): stop dropping trailing newlines'
accepts 'chore!: drop node 18'
accepts 'feat(a/b.c-d)!: nested scope'
accepts 'fix: a'

rejects ''
rejects 'add the thing'
rejects 'Feat: add the thing'
rejects 'feat add the thing'
rejects 'feat:'
rejects 'feat: '
rejects 'docs: not an allowed type'
rejects 'feat: Add the thing'
rejects 'feat(): empty scope'
rejects 'feature: close but no'

# Type lists are validated rather than interpolated blindly.
if conventional_types_to_alternation 'feat,FIX' 2>/dev/null; then
  fail=$((fail + 1))
  printf 'FAIL  expected uppercase type to be rejected\n'
else
  pass=$((pass + 1))
fi

if conventional_types_to_alternation '  ' 2>/dev/null; then
  fail=$((fail + 1))
  printf 'FAIL  expected empty type list to be rejected\n'
else
  pass=$((pass + 1))
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
