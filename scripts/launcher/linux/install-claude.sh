#!/usr/bin/env bash
# Install the adapter-tested Claude Code from the official npm registry.
# $1 = version (e.g. 2.1.270). Must resolve to a native Linux binary.
set -e
VERSION="$1"
sudo npm install -g "@anthropic-ai/claude-code@${VERSION}" 2>&1 | tail -2
p="$(command -v claude)"
echo "PATH=$p"
claude --version 2>&1 | head -1
