#!/usr/bin/env bash
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR" || exit 1

run_gate() {
  local label=$1
  shift
  local log
  log=$(mktemp)
  "$@" >"$log" 2>&1
  local code=$?
  if [ "$code" -eq 0 ]; then
    printf 'PASS %s\n' "$label"
  else
    printf 'FAIL %s (exit %s)\n' "$label" "$code"
    cat "$log" >&2
  fi
  rm -f "$log"
  return "$code"
}

status=0
run_gate 'r1 acceptance focused suite' node --test tests/unit/tango-r1-acceptance.test.mjs || status=1
run_gate 'r1 permitted unit matrix' node --test \
  tests/unit/tango-ai-*.test.mjs \
  tests/unit/tango-assistant*.test.mjs \
  tests/unit/tango-model-catalog-cn.test.mjs || status=1
run_gate 'verify:web (final gate)' npm run verify:web || status=1

exit "$status"
