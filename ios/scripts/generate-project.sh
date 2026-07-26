#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_command xcodegen "Install it with: brew install xcodegen"

cd "${IOS_ROOT}"
xcodegen generate --spec project.yml

echo "Generated ${PROJECT_PATH}"

