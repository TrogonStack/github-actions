#!/usr/bin/env bash
# Conventional Commits grammar, shared by every action in the semconv family.
# Meant to be sourced, not executed.

# Turns a comma or newline separated type list into an ERE alternation.
conventional_types_to_alternation() {
  local raw=$1 token out=""

  while IFS= read -r token; do
    token=${token//[[:space:]]/}
    [ -n "$token" ] || continue

    if [[ ! $token =~ ^[a-z][a-z0-9]*$ ]]; then
      printf 'configured type %q is not lowercase alphanumeric\n' "$token" >&2
      return 2
    fi

    out+="${out:+|}$token"
  # printf adds the trailing newline that read needs to see the final entry.
  done < <(printf '%s\n' "$raw" | tr ',' '\n')

  if [ -z "$out" ]; then
    printf 'no conventional types configured\n' >&2
    return 2
  fi

  printf '%s' "$out"
}

conventional_header_pattern() {
  printf '^(%s)(\([^()]+\))?!?: .+$' "$1"
}

# Explains which part of the grammar a subject missed, so the failure is
# actionable for someone who has never read this repository.
conventional_explain() {
  local subject=$1 alternation=$2 found
  local types="${alternation//|/, }"

  if [ -z "$subject" ]; then
    printf 'subject is empty'
    return
  fi

  if [[ $subject != *:* ]]; then
    printf 'missing the ":" separator; expected "<type>[(scope)][!]: <description>"'
    return
  fi

  found=${subject%%[(:!]*}

  if [[ ! $found =~ ^($alternation)$ ]]; then
    printf 'unknown type "%s"; expected one of: %s' "$found" "$types"
    return
  fi

  if [[ $subject =~ ^($alternation)(\([^()]+\))?!?:[[:space:]]*$ ]]; then
    printf 'empty description after "%s:"' "$found"
    return
  fi

  printf 'malformed header; expected "<type>[(scope)][!]: <description>"'
}

# Returns 0 when the subject is conventional. Otherwise prints the reason on
# stdout and returns 1.
conventional_check_subject() {
  local subject=$1 alternation=$2 subject_pattern=${3-}
  local header_pattern description

  header_pattern=$(conventional_header_pattern "$alternation")

  if [[ ! $subject =~ $header_pattern ]]; then
    conventional_explain "$subject" "$alternation"
    return 1
  fi

  description=${subject#*: }

  if [ -n "$subject_pattern" ] && [[ ! $description =~ $subject_pattern ]]; then
    printf 'description "%s" does not match %s' "$description" "$subject_pattern"
    return 1
  fi

  return 0
}
