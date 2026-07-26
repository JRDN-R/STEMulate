#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_macos
require_command xcodebuild "Install Xcode, then open it once."
require_command xcrun "Install Xcode, then open it once."
require_local_config
require_firebase_config

DEVICE_ID="${1:-}"

if [[ -z "${DEVICE_ID}" ]]; then
  echo "Usage: ./scripts/install-device.sh DEVICE_IDENTIFIER" >&2
  echo "Find it with: ./scripts/list-devices.sh" >&2
  exit 1
fi

"${SCRIPT_DIR}/generate-project.sh"

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme STEMulate \
  -configuration Debug \
  -destination "platform=iOS,id=${DEVICE_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Debug-iphoneos/STEMulate.app"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Build succeeded, but the app was not found at ${APP_PATH}." >&2
  exit 1
fi

xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"

echo
echo "STEMulate is installed. Open it from your iPhone Home Screen."
