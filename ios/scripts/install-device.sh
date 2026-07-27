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
DEVICE_NAME="${2:-}"

if [[ -z "${DEVICE_ID}" ]]; then
  echo "Usage: ./scripts/install-device.sh DEVICE_IDENTIFIER" >&2
  echo "Find it with: ./scripts/list-devices.sh" >&2
  exit 1
fi

"${SCRIPT_DIR}/generate-project.sh"

BUILD_DESTINATION="platform=iOS,id=${DEVICE_ID}"
if [[ -n "${DEVICE_NAME}" ]]; then
  BUILD_DESTINATION="platform=iOS,name=${DEVICE_NAME}"
fi

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme STEMulate \
  -configuration Debug \
  -destination "${BUILD_DESTINATION}" \
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

BUNDLE_ID="$(
  sed -n 's/^PRODUCT_BUNDLE_IDENTIFIER = //p' \
    "${IOS_ROOT}/Config/Local.xcconfig" |
    head -n 1
)"

if [[ -n "${BUNDLE_ID}" ]]; then
  if ! xcrun devicectl device process launch \
    --device "${DEVICE_ID}" \
    --terminate-existing \
    "${BUNDLE_ID}"; then
    echo
    echo "The app installed, but iOS did not launch it automatically."
    echo "If prompted, trust the developer profile, then open STEMulate from the Home Screen."
  fi
fi

echo
echo "STEMulate is installed on the connected iPhone."
