#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

TEAM_ID="${1:-}"
BUNDLE_ID="${2:-}"
FIREBASE_PLIST="${3:-}"
DEVICE_ID="${4:-}"

if [[ -z "${TEAM_ID}" || -z "${BUNDLE_ID}" || -z "${FIREBASE_PLIST}" ]]; then
  echo "Usage:" >&2
  echo "  ./scripts/first-install.sh TEAM_ID BUNDLE_ID GOOGLE_PLIST [DEVICE_ID]" >&2
  echo >&2
  echo "DEVICE_ID is optional; the installer detects a connected iPhone." >&2
  exit 1
fi

ARGS=(
  --team-id "${TEAM_ID}"
  --bundle-id "${BUNDLE_ID}"
  --firebase-plist "${FIREBASE_PLIST}"
)
if [[ -n "${DEVICE_ID}" ]]; then
  ARGS+=(--device "${DEVICE_ID}")
fi
exec "${SCRIPT_DIR}/install-on-iphone.sh" "${ARGS[@]}"
