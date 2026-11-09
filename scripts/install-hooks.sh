#!/bin/sh
# Install the repo's git hooks (kept in scripts/ so they survive a reclone).
set -e
root=$(git rev-parse --show-toplevel)
hooks="$root/.git/hooks"
mkdir -p "$hooks"

cp "$root/scripts/prepare-commit-msg" "$hooks/prepare-commit-msg"
chmod +x "$hooks/prepare-commit-msg"
echo "installed $hooks/prepare-commit-msg"
