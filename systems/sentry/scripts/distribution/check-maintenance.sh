#!/usr/bin/env bash
set -euo pipefail
DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$DIST/scripts/distribution/maintenance.mjs"
