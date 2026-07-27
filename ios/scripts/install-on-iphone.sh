#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

TEAM_ID=""
BUNDLE_ID=""
FIREBASE_PLIST=""
DEVICE_ID=""
DEVICE_NAME=""
RESET_LOCAL_STATE=false
XCODEGEN_VERSION="2.45.4"

usage() {
  cat <<'EOF'
Install STEMulate on a connected iPhone in one guided run.

Usage:
  ./install-iphone.command [options]

Options:
  --firebase-plist PATH  GoogleService-Info.plist for the iOS app
  --team-id TEAM_ID      Ten-character Apple development team ID
  --bundle-id BUNDLE_ID  Must match the Firebase plist
  --device DEVICE_ID     Connected iPhone identifier
  --reset                Forget locally saved installer choices
  -h, --help             Show this help

The script never uploads signing credentials or Firebase configuration to Git.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --firebase-plist)
      FIREBASE_PLIST="${2:-}"
      shift 2
      ;;
    --team-id)
      TEAM_ID="${2:-}"
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      shift 2
      ;;
    --device)
      DEVICE_ID="${2:-}"
      shift 2
      ;;
    --reset)
      RESET_LOCAL_STATE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_macos

STATE_PATH="${IOS_ROOT}/Config/Install.local"
LOCAL_CONFIG="${IOS_ROOT}/Config/Local.xcconfig"
FIREBASE_DESTINATION="${IOS_ROOT}/STEMulate/Resources/GoogleService-Info.plist"
APP_CHECK_CONFIG="${IOS_ROOT}/Config/AppCheck.xcconfig"
PLIST_BUDDY="/usr/libexec/PlistBuddy"

if [[ "${RESET_LOCAL_STATE}" == "true" ]]; then
  rm -f \
    "${STATE_PATH}" \
    "${APP_CHECK_CONFIG}" \
    "${LOCAL_CONFIG}" \
    "${IOS_ROOT}/Config/Firebase.xcconfig"
  if [[ -z "${FIREBASE_PLIST}" ]]; then
    rm -f "${FIREBASE_DESTINATION}"
  fi
fi

echo
echo "STEMulate iPhone installer"
echo "=========================="

if [[ ! -d "/Applications/Xcode.app" ]] && ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  echo "Install the full Xcode app first, then run this same command again." >&2
  open "macappstore://itunes.apple.com/app/id497799835" >/dev/null 2>&1 || true
  exit 1
fi

if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  echo "Selecting the full Xcode developer directory (macOS may ask for your password)..."
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
fi

require_command xcodebuild "Install Xcode from the Mac App Store."
require_command xcrun "Install Xcode from the Mac App Store."
require_command git "Install Xcode command-line tools."
require_command swift "Install the full Xcode app."

if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo "Finishing Xcode's one-time component setup (macOS may ask for your password)..."
  sudo xcodebuild -runFirstLaunch
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing XcodeGen..."
    brew install xcodegen
  else
    TOOL_ROOT="${IOS_ROOT}/.tools"
    XCODEGEN_SOURCE="${TOOL_ROOT}/XcodeGen-${XCODEGEN_VERSION}"
    XCODEGEN_BINARY="${TOOL_ROOT}/bin/xcodegen"
    mkdir -p "${TOOL_ROOT}/bin"
    if [[ ! -x "${XCODEGEN_BINARY}" ]]; then
      echo "Building the pinned XcodeGen ${XCODEGEN_VERSION} helper..."
      if [[ ! -d "${XCODEGEN_SOURCE}/.git" ]]; then
        git clone \
          --depth 1 \
          --branch "${XCODEGEN_VERSION}" \
          https://github.com/yonaskolb/XcodeGen.git \
          "${XCODEGEN_SOURCE}"
      fi
      swift build \
        --package-path "${XCODEGEN_SOURCE}" \
        --configuration release \
        --product xcodegen
      XCODEGEN_BIN_DIRECTORY="$(
        swift build \
          --package-path "${XCODEGEN_SOURCE}" \
          --configuration release \
          --show-bin-path
      )"
      cp "${XCODEGEN_BIN_DIRECTORY}/xcodegen" "${XCODEGEN_BINARY}"
      chmod 755 "${XCODEGEN_BINARY}"
    fi
    export PATH="${TOOL_ROOT}/bin:${PATH}"
  fi
fi

if [[ -z "${FIREBASE_PLIST}" && -f "${FIREBASE_DESTINATION}" ]]; then
  FIREBASE_PLIST="${FIREBASE_DESTINATION}"
fi

if [[ -z "${FIREBASE_PLIST}" ]]; then
  FIREBASE_CANDIDATES=()
  for candidate in \
    "${HOME}/Downloads"/GoogleService-Info*.plist \
    "${HOME}/Desktop"/GoogleService-Info*.plist; do
    if [[ -f "${candidate}" ]]; then
      FIREBASE_CANDIDATES+=("${candidate}")
    fi
  done

  if [[ ${#FIREBASE_CANDIDATES[@]} -eq 1 ]]; then
    FIREBASE_PLIST="${FIREBASE_CANDIDATES[0]}"
  elif [[ ${#FIREBASE_CANDIDATES[@]} -gt 1 ]]; then
    echo
    echo "Choose the Firebase plist for the STEMulate iOS app:"
    select candidate in "${FIREBASE_CANDIDATES[@]}"; do
      if [[ -n "${candidate:-}" ]]; then
        FIREBASE_PLIST="${candidate}"
        break
      fi
    done
  elif command -v osascript >/dev/null 2>&1; then
    echo
    echo "Choose the GoogleService-Info.plist downloaded from Firebase."
    FIREBASE_PLIST="$(
      osascript -e \
        'POSIX path of (choose file with prompt "Choose GoogleService-Info.plist for STEMulate")' \
        2>/dev/null || true
    )"
  fi
fi

if [[ -z "${FIREBASE_PLIST}" || ! -f "${FIREBASE_PLIST}" ]]; then
  echo "A Firebase iOS configuration is required." >&2
  echo "Download GoogleService-Info.plist from Firebase Project settings, then rerun." >&2
  exit 1
fi
if ! plutil -lint "${FIREBASE_PLIST}" >/dev/null; then
  echo "The selected Firebase plist is invalid." >&2
  exit 1
fi

PLIST_BUNDLE_ID="$(
  "${PLIST_BUDDY}" -c "Print :BUNDLE_ID" "${FIREBASE_PLIST}" 2>/dev/null || true
)"
FIREBASE_PROJECT_ID="$(
  "${PLIST_BUDDY}" -c "Print :PROJECT_ID" "${FIREBASE_PLIST}" 2>/dev/null || true
)"
if [[ -z "${PLIST_BUNDLE_ID}" || -z "${FIREBASE_PROJECT_ID}" ]]; then
  echo "The Firebase plist is missing BUNDLE_ID or PROJECT_ID." >&2
  exit 1
fi
if [[ -n "${BUNDLE_ID}" && "${BUNDLE_ID}" != "${PLIST_BUNDLE_ID}" ]]; then
  echo "Bundle ID mismatch." >&2
  echo "Command: ${BUNDLE_ID}" >&2
  echo "Firebase: ${PLIST_BUNDLE_ID}" >&2
  exit 1
fi
BUNDLE_ID="${PLIST_BUNDLE_ID}"

if [[ -z "${TEAM_ID}" && -f "${LOCAL_CONFIG}" ]]; then
  TEAM_ID="$(sed -n 's/^DEVELOPMENT_TEAM = //p' "${LOCAL_CONFIG}" | head -n 1)"
fi
if [[ -z "${TEAM_ID}" && -f "${STATE_PATH}" ]]; then
  TEAM_ID="$(sed -n 's/^TEAM_ID=//p' "${STATE_PATH}" | head -n 1)"
fi

if [[ -z "${TEAM_ID}" ]]; then
  TEAM_IDS=()
  while IFS= read -r discovered_team; do
    already_present=false
    for known_team in "${TEAM_IDS[@]:-}"; do
      if [[ "${known_team}" == "${discovered_team}" ]]; then
        already_present=true
      fi
    done
    if [[ "${already_present}" == "false" ]]; then
      TEAM_IDS+=("${discovered_team}")
    fi
  done < <(
    security find-identity -v -p codesigning 2>/dev/null |
      sed -En 's/.*\(([A-Z0-9]{10})\).*/\1/p'
  )

  if [[ ${#TEAM_IDS[@]} -eq 1 ]]; then
    TEAM_ID="${TEAM_IDS[0]}"
  elif [[ ${#TEAM_IDS[@]} -gt 1 ]]; then
    echo
    echo "Choose the Apple development team:"
    select discovered_team in "${TEAM_IDS[@]}"; do
      if [[ -n "${discovered_team:-}" ]]; then
        TEAM_ID="${discovered_team}"
        break
      fi
    done
  fi
fi

if [[ -z "${TEAM_ID}" ]]; then
  echo
  echo "Xcode has not created an Apple Development identity yet."
  echo "Open Xcode → Settings → Accounts, add your Apple ID, and select your Personal Team."
  open -a Xcode >/dev/null 2>&1 || true
  read -r -p "Enter the 10-character Team ID shown by Xcode: " TEAM_ID
fi
if [[ ! "${TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "TEAM_ID must contain ten uppercase letters or numbers." >&2
  exit 1
fi

if [[ -z "${DEVICE_ID}" && -f "${STATE_PATH}" ]]; then
  SAVED_DEVICE_ID="$(sed -n 's/^DEVICE_ID=//p' "${STATE_PATH}" | head -n 1)"
  if [[ -n "${SAVED_DEVICE_ID}" ]] &&
     xcrun devicectl list devices 2>/dev/null |
       grep -Ei 'available|connected' |
       grep -Eiv 'unavailable|disconnected' |
       grep -i 'iPhone' |
       grep -q "${SAVED_DEVICE_ID}"; then
    DEVICE_ID="${SAVED_DEVICE_ID}"
    DEVICE_NAME="$(sed -n 's/^DEVICE_NAME=//p' "${STATE_PATH}" | head -n 1)"
  fi
fi

if [[ -z "${DEVICE_ID}" ]]; then
  DEVICE_IDS=()
  while IFS= read -r discovered_device; do
    DEVICE_IDS+=("${discovered_device}")
  done < <(
    xcrun devicectl list devices 2>/dev/null |
      grep -Ei 'available|connected' |
      grep -Eiv 'unavailable|disconnected' |
      grep -i 'iPhone' |
      grep -Eo \
        '([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16})'
  )

  if [[ ${#DEVICE_IDS[@]} -eq 1 ]]; then
    DEVICE_ID="${DEVICE_IDS[0]}"
  elif [[ ${#DEVICE_IDS[@]} -gt 1 ]]; then
    echo
    echo "Choose a connected iPhone:"
    select discovered_device in "${DEVICE_IDS[@]}"; do
      if [[ -n "${discovered_device:-}" ]]; then
        DEVICE_ID="${discovered_device}"
        break
      fi
    done
  fi
fi

if [[ -z "${DEVICE_ID}" ]]; then
  echo
  echo "No ready iPhone was detected."
  echo "Connect and unlock it, tap Trust, and enable Settings → Privacy & Security → Developer Mode."
  echo
  "${SCRIPT_DIR}/list-devices.sh" || true
  echo
  read -r -p "Enter the connected iPhone identifier: " DEVICE_ID
fi
if [[ -z "${DEVICE_ID}" ]]; then
  echo "An iPhone identifier is required." >&2
  exit 1
fi
if [[ -z "${DEVICE_NAME}" ]]; then
  DEVICE_NAME="$(
    {
      xcrun devicectl list devices 2>/dev/null |
        grep "${DEVICE_ID}" |
        head -n 1 |
        awk -F '  +' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1}'
    } || true
  )"
fi

"${SCRIPT_DIR}/configure.sh" "${TEAM_ID}" "${BUNDLE_ID}"
"${SCRIPT_DIR}/configure-firebase.sh" "${FIREBASE_PLIST}"

NEW_APP_CHECK_TOKEN=false
if [[ ! -f "${APP_CHECK_CONFIG}" ]]; then
  APP_CHECK_TOKEN="$(uuidgen)"
  printf '%s\n' \
    '// Generated locally by install-on-iphone.sh. Do not commit.' \
    "APP_CHECK_DEBUG_TOKEN = ${APP_CHECK_TOKEN}" \
    > "${APP_CHECK_CONFIG}"
  NEW_APP_CHECK_TOKEN=true
else
  APP_CHECK_TOKEN="$(
    sed -n 's/^APP_CHECK_DEBUG_TOKEN = //p' "${APP_CHECK_CONFIG}" | head -n 1
  )"
fi

if [[ "${NEW_APP_CHECK_TOKEN}" == "true" ]]; then
  echo
  echo "One Firebase App Check step"
  echo "---------------------------"
  echo "The private debug token has been copied to your clipboard:"
  echo "${APP_CHECK_TOKEN}"
  printf '%s' "${APP_CHECK_TOKEN}" | pbcopy
  open "https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/appcheck" \
    >/dev/null 2>&1 || true
  echo
  echo "In Firebase: select the STEMulate iOS app → Manage debug tokens → add this token."
  read -r -p "Press Return after Firebase says the token is saved: " _
fi

printf '%s\n' \
  "TEAM_ID=${TEAM_ID}" \
  "BUNDLE_ID=${BUNDLE_ID}" \
  "DEVICE_ID=${DEVICE_ID}" \
  "DEVICE_NAME=${DEVICE_NAME}" \
  "FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}" \
  > "${STATE_PATH}"

echo
echo "Building, signing, installing, and launching STEMulate..."
"${SCRIPT_DIR}/install-device.sh" "${DEVICE_ID}" "${DEVICE_NAME}"

echo
echo "Done. Future seven-day renewals use the same command:"
echo "  ./install-iphone.command"
