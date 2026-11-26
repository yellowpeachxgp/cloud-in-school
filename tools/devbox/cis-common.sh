#!/usr/bin/env bash
# Shared helpers for the campus devbox scripts. This file is sourced, not executed.

if [ -n "${CIS_COMMON_LOADED:-}" ]; then
  return 0 2>/dev/null || true
fi
CIS_COMMON_LOADED=1

if [ -z "${CIS_CAMPUS_ROOT+x}" ]; then
  _cis_common_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  if [ "$(basename -- "$_cis_common_dir")" = bin ]; then
    CIS_CAMPUS_ROOT=$(dirname -- "$_cis_common_dir")
  else
    printf '%s\n' 'cis: ERROR: CIS_CAMPUS_ROOT is required when scripts are not installed in a campus bin directory' >&2
    exit 2
  fi
fi
CIS_CAMPUS_ROOT=${CIS_CAMPUS_ROOT%/}
case "$CIS_CAMPUS_ROOT" in
  ''|/)
    printf '%s\n' 'cis: ERROR: CIS_CAMPUS_ROOT must be a non-root absolute path' >&2
    exit 2
    ;;
  /*) ;;
  *)
    printf '%s\n' 'cis: ERROR: CIS_CAMPUS_ROOT must be an absolute path' >&2
    exit 2
    ;;
esac
export CIS_CAMPUS_ROOT

CIS_MIN_MEM_AVAILABLE_KB=${CIS_MIN_MEM_AVAILABLE_KB:-25165824} # 24 GiB in KiB
CIS_PAUSE_FILE=${CIS_PAUSE_FILE:-$CIS_CAMPUS_ROOT/PAUSE}

cis_info() {
  printf 'cis: %s\n' "$*" >&2
}

cis_die() {
  printf 'cis: ERROR: %s\n' "$*" >&2
  exit 2
}

cis_need_cmd() {
  command -v "$1" >/dev/null 2>&1 || cis_die "missing required command: $1"
}

cis_mem_available_kb() {
  awk '/^MemAvailable:/ { print $2; found=1 } END { if (!found) print 0 }' /proc/meminfo 2>/dev/null || printf '0\n'
}

cis_mem_total_kb() {
  awk '/^MemTotal:/ { print $2; found=1 } END { if (!found) print 0 }' /proc/meminfo 2>/dev/null || printf '0\n'
}

cis_wait_resources() {
  local label=${1:-build}
  local waited=0
  while true; do
    local blockers=()
    if [ -e "$CIS_PAUSE_FILE" ]; then
      blockers+=("PAUSE file present: $CIS_PAUSE_FILE")
    fi
    local available
    available=$(cis_mem_available_kb)
    if [ "$available" -lt "$CIS_MIN_MEM_AVAILABLE_KB" ]; then
      blockers+=("MemAvailable ${available}kB is below ${CIS_MIN_MEM_AVAILABLE_KB}kB")
    fi
    if [ ${#blockers[@]} -eq 0 ]; then
      if [ "$waited" -gt 0 ]; then
        cis_info "$label resources available after ${waited}s"
      fi
      return 0
    fi
    if [ $((waited % 30)) -eq 0 ]; then
      cis_info "$label waiting: ${blockers[*]}"
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

cis_require_under_campus() {
  case "$1" in
    "$CIS_CAMPUS_ROOT"/*) ;;
    *) cis_die "refusing to touch path outside $CIS_CAMPUS_ROOT: $1" ;;
  esac
}

cis_sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{ print $1 }'
  else
    cis_die "missing sha256sum or shasum"
  fi
}

cis_branch_key() {
  cis_sha256_text "$1" | cut -c1-12
}

cis_sanitize_branch() {
  printf '%s' "$1"     | tr '[:upper:]' '[:lower:]'     | sed -e 's/[^a-z0-9][^a-z0-9]*/-/g' -e 's/^-//' -e 's/-$//'     | cut -c1-32
}
