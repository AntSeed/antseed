#!/usr/bin/env bash
# Regenerate the pnpmDeps fixed-output hash in flake.nix.
#
# Run this after any change to pnpm-lock.yaml (dependency bumps, new
# workspace packages, lockfile regeneration):
#
#   ./scripts/update-nix-hash.sh
#
# It blanks the hash, lets `nix build` fail with a mismatch that reports
# the correct fixed-output hash, writes that value back, and rebuilds to
# verify.

set -euo pipefail

cd "$(dirname "$0")/.."

FLAKE=flake.nix
EMPTY='sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

# The pnpmDeps hash is the only literal `hash = "sha256-..."` assignment in
# flake.nix (the native prebuild hashes live in per-system attrsets), so the
# first match is the right one. sed -i.bak works with both GNU and BSD sed.
# `|` delimiters because base64 hashes contain `/`.
if ! grep -q "hash = \"$EMPTY\";" "$FLAKE"; then
  sed -i.bak -E '0,\|hash = "sha256-[A-Za-z0-9+/=]+";|s||hash = "'"$EMPTY"'";|' "$FLAKE"
  rm -f "$FLAKE.bak"
fi

echo "Building with a placeholder hash to compute the real one..."
echo "(this fetches every npm dependency — a few minutes on a cold cache)"
got="$(nix build .# 2>&1 | grep -Eo 'got: +sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | tail -1 || true)"

if [ -z "$got" ]; then
  echo "error: could not read the correct hash from the nix build output." >&2
  echo "$FLAKE still holds the empty placeholder — restore it from git" >&2
  echo "(git checkout -- $FLAKE) and investigate the build failure." >&2
  exit 1
fi

sed -i.bak -E '0,\|hash = "sha256-[A-Za-z0-9+/=]+";|s||hash = "'"$got"'";|' "$FLAKE"
rm -f "$FLAKE.bak"
echo "Updated pnpmDeps hash in $FLAKE: $got"

echo "Verifying with a full build..."
nix build .#
echo "OK — smoke test:"
./result/bin/antseed --version
