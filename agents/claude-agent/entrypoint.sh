#!/bin/sh
# Permission prompts are skipped because the container is the security boundary.
set -eu
cd /workspace
exec claude -p "$TASK" --dangerously-skip-permissions
