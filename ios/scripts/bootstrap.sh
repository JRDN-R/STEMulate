#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_macos
require_command xcodebuild "Install Xcode from the Mac App Store, then open it once."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode command-line tools are not selected." >&2
  echo "Run: sudo xcode-select --switch /Applications/Xcode.app" >&2
  exit 1
fi

if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo "Xcode still needs its first-launch components." >&2
  echo "Open Xcode once, or run: sudo xcodebuild -runFirstLaunch" >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing XcodeGen with Homebrew..."
    brew install xcodegen
  else
    echo "XcodeGen is required." >&2
    echo "Install Homebrew from https://brew.sh, then run: brew install xcodegen" >&2
    exit 1
  fi
fi

if [[ ! -f "${IOS_ROOT}/Config/Local.xcconfig" ]]; then
  cp "${IOS_ROOT}/Config/Local.xcconfig.example" "${IOS_ROOT}/Config/Local.xcconfig"
  echo
  echo "Created Config/Local.xcconfig with placeholder signing values."
  echo "Next: ./scripts/configure.sh YOUR_TEAM_ID com.yourname.STEMulate"
fi

"${SCRIPT_DIR}/generate-project.sh"

echo
echo "Setup complete: ${PROJECT_PATH}"

