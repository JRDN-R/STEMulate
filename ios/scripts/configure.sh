#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

TEAM_ID="${1:-}"
BUNDLE_ID="${2:-}"

if [[ ! "${TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Usage: ./scripts/configure.sh TEAM_ID BUNDLE_ID" >&2
  echo "TEAM_ID must be ten uppercase letters/numbers." >&2
  exit 1
fi

if [[ ! "${BUNDLE_ID}" =~ ^[A-Za-z][A-Za-z0-9.-]+$ ]] || [[ "${BUNDLE_ID}" != *.* ]]; then
  echo "BUNDLE_ID must look like com.yourname.STEMulate." >&2
  exit 1
fi

printf '%s\n' \
  '// Generated locally by scripts/configure.sh. Do not commit.' \
  "DEVELOPMENT_TEAM = ${TEAM_ID}" \
  "PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID}" \
  "TEST_PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID}.tests" \
  'MARKETING_VERSION = 1.0' \
  'CURRENT_PROJECT_VERSION = 1' \
  > "${IOS_ROOT}/Config/Local.xcconfig"

echo "Configured automatic signing for ${BUNDLE_ID}."

if command -v xcodegen >/dev/null 2>&1; then
  "${SCRIPT_DIR}/generate-project.sh"
fi
