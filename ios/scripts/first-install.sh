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
  echo "Run without DEVICE_ID first; the script will list connected devices." >&2
  exit 1
fi

require_macos
"${SCRIPT_DIR}/bootstrap.sh"
"${SCRIPT_DIR}/configure.sh" "${TEAM_ID}" "${BUNDLE_ID}"
"${SCRIPT_DIR}/configure-firebase.sh" "${FIREBASE_PLIST}"

if [[ -z "${DEVICE_ID}" ]]; then
  echo
  echo "Configuration is ready. Connected devices:"
  "${SCRIPT_DIR}/list-devices.sh"
  echo
  echo "Rerun this command with the iPhone identifier as the fourth argument."
  exit 0
fi

"${SCRIPT_DIR}/install-device.sh" "${DEVICE_ID}"
