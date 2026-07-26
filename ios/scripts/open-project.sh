#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_macos

if [[ ! -d "${PROJECT_PATH}" ]]; then
  "${SCRIPT_DIR}/generate-project.sh"
fi

open "${PROJECT_PATH}"

