#!/usr/bin/env bash
# Install missing apt packages. Args: package names.
set -e
sudo apt-get update
sudo apt-get install -y "$@"
