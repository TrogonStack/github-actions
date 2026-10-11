#!/usr/bin/env bash
set -euo pipefail

args=(-color)
if [ -n "${CONFIG:-}" ]; then
  args+=(-config-file "$CONFIG")
fi
if [ -n "${EXTRA_ARGS:-}" ]; then
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      args+=("$line")
    fi
  done <<<"$EXTRA_ARGS"
fi

actionlint "${args[@]}"
