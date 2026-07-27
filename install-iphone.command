#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${REPOSITORY_ROOT}/ios/scripts/install-on-iphone.sh" "$@"
