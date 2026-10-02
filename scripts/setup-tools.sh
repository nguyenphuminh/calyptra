#!/usr/bin/env bash
# Installs the toolchains into the home directory (no sudo, shell profile untouched):
# Node.js 24, circom 2.2.3, Foundry (forge, anvil, cast) and the PSE powers of tau (2^17).
set -euo pipefail

TOOLS="$HOME/.local/share/calyptra-tools"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin" "$TOOLS/ptau"
cd "$WORK"

if ! command -v node >/dev/null || [[ "$(node --version)" != v24* ]]; then
  version="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v24\.[0-9.]*"' | head -1 | cut -d'"' -f4)"
  echo "installing Node.js $version"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" -o node.tar.xz
  rm -rf "$HOME/.local/opt/node" && mkdir -p "$HOME/.local/opt/node"
  tar -xJf node.tar.xz --strip-components=1 -C "$HOME/.local/opt/node"
fi

if ! command -v circom >/dev/null; then
  echo "installing circom 2.2.3"
  curl -fsSL https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64 -o "$HOME/.local/bin/circom"
  chmod +x "$HOME/.local/bin/circom"
fi

if ! command -v forge >/dev/null && [[ ! -x "$HOME/.foundry/bin/forge" ]]; then
  echo "installing Foundry"
  curl -fsSL https://foundry.paradigm.xyz -o foundryup-init.sh
  sh foundryup-init.sh -y -q
  "$HOME/.foundry/bin/foundryup"
fi

if [[ ! -f "$TOOLS/ptau/ppot_0080_17.ptau" ]]; then
  echo "downloading powers of tau (2^17)"
  wget -c https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau \
    -O "$TOOLS/ptau/ppot_0080_17.ptau"
fi

echo "tools ready; run: source scripts/env.sh && npm install && npm run setup"
