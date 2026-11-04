#!/bin/sh
# Build the Linux x86_64 (Debian/Ubuntu) release package from the current source, with the private Node.js,
# the Registry bridge, the provider scripts and the notices, then verify the package CONTENT.
set -eu
cd "$(dirname "$0")/.."
( cd ../../native && cargo build --release --workspace )
node packaging/fetch-node.mjs --verify-signature
node packaging/stage-resources.mjs
# gen-notices reads `cargo metadata --offline`, so every crate must already be in the local registry cache.
# The native build fetched only the native workspace; fetch the desktop backend's crates too (clean machines).
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
node packaging/gen-notices.mjs
npm run tauri -- build --bundles deb
node packaging/verify-package.mjs src-tauri/target/release/bundle/deb/Nexus_*_amd64.deb
