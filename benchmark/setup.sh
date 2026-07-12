#!/usr/bin/env bash
# Compatibility wrapper. New usage: setup.sh [dir] [task]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/brittain-bench}"
TASK="${2:-cart}"
exec node "$SCRIPT_DIR/setup.js" --task "$TASK" --dir "$DIR"
