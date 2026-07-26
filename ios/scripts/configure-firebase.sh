#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

SOURCE_PLIST="${1:-}"
DESTINATION_PLIST="${IOS_ROOT}/STEMulate/Resources/GoogleService-Info.plist"
FIREBASE_CONFIG="${IOS_ROOT}/Config/Firebase.xcconfig"
PLIST_BUDDY="/usr/libexec/PlistBuddy"

require_macos

if [[ -z "${SOURCE_PLIST}" || ! -f "${SOURCE_PLIST}" ]]; then
  echo "Usage: ./scripts/configure-firebase.sh /path/to/GoogleService-Info.plist" >&2
  exit 1
fi

if [[ ! -x "${PLIST_BUDDY}" ]]; then
  echo "Could not find ${PLIST_BUDDY}." >&2
  exit 1
fi

if ! plutil -lint "${SOURCE_PLIST}" >/dev/null; then
  echo "The selected file is not a valid property list." >&2
  exit 1
fi

REVERSED_CLIENT_ID="$("${PLIST_BUDDY}" -c "Print :REVERSED_CLIENT_ID" "${SOURCE_PLIST}" 2>/dev/null || true)"
PROJECT_ID="$("${PLIST_BUDDY}" -c "Print :PROJECT_ID" "${SOURCE_PLIST}" 2>/dev/null || true)"
PLIST_BUNDLE_ID="$("${PLIST_BUDDY}" -c "Print :BUNDLE_ID" "${SOURCE_PLIST}" 2>/dev/null || true)"

if [[ ! "${REVERSED_CLIENT_ID}" =~ ^[A-Za-z][A-Za-z0-9.-]+$ ]]; then
  echo "GoogleService-Info.plist is missing a valid REVERSED_CLIENT_ID." >&2
  echo "Enable Google sign-in for the Firebase iOS app, then download the plist again." >&2
  exit 1
fi

if [[ -z "${PROJECT_ID}" ]]; then
  echo "GoogleService-Info.plist is missing PROJECT_ID." >&2
  exit 1
fi

if [[ -z "${PLIST_BUNDLE_ID}" ]]; then
  echo "GoogleService-Info.plist is missing BUNDLE_ID." >&2
  exit 1
fi

LOCAL_CONFIG="${IOS_ROOT}/Config/Local.xcconfig"
if [[ -f "${LOCAL_CONFIG}" ]]; then
  CONFIGURED_BUNDLE_ID="$(
    sed -n 's/^PRODUCT_BUNDLE_IDENTIFIER = //p' "${LOCAL_CONFIG}" | head -n 1
  )"
  if [[ -n "${CONFIGURED_BUNDLE_ID}" && "${PLIST_BUNDLE_ID}" != "${CONFIGURED_BUNDLE_ID}" ]]; then
    echo "Firebase bundle ID mismatch." >&2
    echo "Configured app: ${CONFIGURED_BUNDLE_ID}" >&2
    echo "Firebase plist: ${PLIST_BUNDLE_ID}" >&2
    echo "Download the plist for the matching Firebase iOS app." >&2
    exit 1
  fi
fi

if ! cmp -s "${SOURCE_PLIST}" "${DESTINATION_PLIST}" 2>/dev/null; then
  cp "${SOURCE_PLIST}" "${DESTINATION_PLIST}"
fi

printf '%s\n' \
  '// Generated locally by scripts/configure-firebase.sh. Do not commit.' \
  "GOOGLE_REVERSED_CLIENT_ID = ${REVERSED_CLIENT_ID}" \
  > "${FIREBASE_CONFIG}"

echo "Configured Firebase project ${PROJECT_ID} and the Google sign-in URL scheme."

if command -v xcodegen >/dev/null 2>&1; then
  "${SCRIPT_DIR}/generate-project.sh"
fi
