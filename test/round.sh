#!/usr/bin/env bash
# One round of checks on a machine with a GPU, in sequence (harnesses must
# not overlap), each step's output saved to an evidence folder plus a
# summary of the lines that matter. Meant for the M1 Pro: the cloud
# workspace runs everything in SwiftShader on two cores, where one stall
# check takes ~10 min.
#
# Usage: pnpm test:round <evidence-dir> [ab-flag]
#   ab-flag   a test:profile flag for the A/B run (e.g. --nostrips); the
#             profile then runs twice, without and with it
# Environment:
#   PROFILE   test:profile arguments (default: the dpr 2 band scroll runs)
#   SKIP      steps to leave out, space-separated: visual fx edit fill profile
#   LABEL     file-name label for the machine (default m1pro)
set -u

[[ ${1:-} == -- ]] && shift
dir=${1:?usage: pnpm test:round <evidence-dir> [ab-flag]}
ab=${2:-}
profile=${PROFILE:---only scroll,scroll-long --nodim --dpr 2 --band}
skip=" ${SKIP:-} "
label=${LABEL:-m1pro}
day=$(date +%F)
mkdir -p "$dir"
summary="$dir/$day-$label-round.txt"
: > "$summary"

note() {
  echo "$*" | tee -a "$summary"
}

# run <name> <command...>: output to <dir>/<day>-<label>-<name>.txt.
run() {
  local name=$1
  shift
  local out="$dir/$day-$label-$name.txt"
  echo "== $name: $*"
  "$@" 2>&1 | grep -v '^npm warn' | tee "$out"
  local status=${PIPESTATUS[0]}
  note "== $name (exit $status): $*"
  case $name in
    visual) grep -E 'fail|no-golden|\[visual\]' "$out" >> "$summary" ;;
    fx) grep -E 'fail|\[fx\]' "$out" >> "$summary" ;;
    edit) grep -vE '^\[|^\s*$' "$out" | tail -8 >> "$summary" ;;
    fill*) grep -E 'rows drawn' "$out" >> "$summary" ;;
    profile*)
      grep -E '^\S+: [0-9]+ frames|late|frame interval|cpu total|gpu total|^\s+(main|copy)\s|hitch' \
        "$out" >> "$summary"
      ;;
  esac
}

wants() {
  [[ $skip != *" $1 "* ]]
}

note "round $day on $(uname -n), $(git rev-parse --short HEAD)" \
  "$(git status --short | wc -l | tr -d ' ') files changed"
wants visual && run visual npx tsx test/visual/run.ts
wants fx && run fx npx tsx test/fx/run.ts
wants edit && run edit npx tsx test/edit/run.ts --headed
if wants fill; then
  run fill npx tsx test/fill/run.ts --headed
  run fill-up npx tsx test/fill/run.ts --headed --up
fi
if wants profile; then
  # shellcheck disable=SC2086
  run profile npx tsx test/profile/run.ts --headed $profile
  if [[ -n $ab ]]; then
    # shellcheck disable=SC2086
    run "profile${ab}" npx tsx test/profile/run.ts --headed $profile "$ab"
  fi
fi
echo
echo "summary: $summary"
cat "$summary"
