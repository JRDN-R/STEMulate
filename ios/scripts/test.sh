#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_macos
require_command xcodebuild "Install Xcode, then open it once."

DEVICE_NAME="${1:-iPhone 16 Pro}"

"${SCRIPT_DIR}/generate-project.sh"

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme STEMulate \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=${DEVICE_NAME}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  test

