#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROJECT_PATH="${IOS_ROOT}/STEMulate.xcodeproj"
DERIVED_DATA_PATH="${IOS_ROOT}/DerivedData"

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing ${command_name}. ${install_hint}" >&2
    exit 1
  fi
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This command must run on a Mac with Xcode installed." >&2
    exit 1
  fi
}

require_local_config() {
  local config_path="${IOS_ROOT}/Config/Local.xcconfig"

  if [[ ! -f "${config_path}" ]]; then
    echo "Missing Config/Local.xcconfig." >&2
    echo "Run: ./scripts/configure.sh YOUR_TEAM_ID com.yourname.STEMulate" >&2
    exit 1
  fi

  if ! grep -Eq '^DEVELOPMENT_TEAM = [A-Z0-9]{10}$' "${config_path}"; then
    echo "Config/Local.xcconfig does not contain a valid DEVELOPMENT_TEAM." >&2
    exit 1
  fi
}

require_firebase_config() {
  local plist_path="${IOS_ROOT}/STEMulate/Resources/GoogleService-Info.plist"
  local firebase_config_path="${IOS_ROOT}/Config/Firebase.xcconfig"

  if [[ ! -f "${plist_path}" || ! -f "${firebase_config_path}" ]]; then
    echo "Firebase is not configured for this iOS bundle ID." >&2
    echo "Run: ./scripts/configure-firebase.sh /path/to/GoogleService-Info.plist" >&2
    exit 1
  fi
}
