#!/usr/bin/env bash
# Install missing system packages.
# Runs as root via `wsl -d <distro> -u root` (no interactive sudo).
# Args: package names.
set -e
apt-get update
apt-get install -y "$@"
