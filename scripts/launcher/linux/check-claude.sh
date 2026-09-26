#!/usr/bin/env bash
# Report the claude binary: PATH=<path> NATIVE=<linux|windows-mount|missing> + version.
set -u
p="$(command -v claude 2>/dev/null || echo MISSING)"
echo "PATH=$p"
case "$p" in
  /mnt/c*) echo NATIVE=windows-mount ;;
  MISSING) echo NATIVE=missing ;;
  *) echo NATIVE=linux ;;
esac
if [ "$p" != MISSING ]; then claude --version 2>&1 | head -1; fi
