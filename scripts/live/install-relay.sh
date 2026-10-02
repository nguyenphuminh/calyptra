#!/usr/bin/env bash
# Installs (or updates) the Calyptra relay host: the desktop client as transaction relayer, libp2p
# relay and wallet-sync proxy (and, with an offer, the merchant), behind Caddy with automatic HTTPS.
# Runs as root on the VM; idempotent. Started by `npm run deploy:live`.
#
# Usage: install-relay.sh <node version> <relay host name> <relayer account> <network id> [merchant offer file]
# Files next to this script: release.tgz, node.env, node-data.tgz (first install only),
# and with merchant mode the offer file and artifacts.tgz (the proving files, needed to prove disputes).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_VERSION="$1"
RELAY_HOST="$2"
RELAYER_ACCOUNT="$3"
NETWORK_ID="$4"
MERCHANT_OFFER="${5:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
# Relayer fees (§11.2 defaults; re-tune from measured gas, §13.1 V3).
FEE_NATIVE="0.35"
FEE_STABLECOIN="0.01"

# 1. Node.js, the same version as on the deploying machine (it runs the .ts sources directly).
if [ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  apt-get update -q
  apt-get install -y -q xz-utils curl ca-certificates gnupg
  rm -rf /opt/node
  mkdir -p /opt/node
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C /opt/node
fi

# 2. Caddy from its official package repository; it obtains and renews the certificate on its own.
if ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# 3. System user and data. Later deploys never overwrite the VM's wallet data.
id calyptra >/dev/null 2>&1 || useradd --system --home-dir /var/lib/calyptra --shell /usr/sbin/nologin calyptra
install -d -o calyptra -g calyptra -m 700 /var/lib/calyptra
if [ ! -d /var/lib/calyptra/node ]; then
  tar -xzf "$HERE/node-data.tgz" -C /var/lib/calyptra
  chown -R calyptra:calyptra /var/lib/calyptra/node
fi
install -d -m 700 /etc/calyptra
install -m 600 "$HERE/node.env" /etc/calyptra/node.env

# 4. The release: committed files only, production dependencies, the three newest kept.
RELEASE="/opt/calyptra/releases/$RELEASE_ID"
mkdir -p "$RELEASE"
tar -xzf "$HERE/release.tgz" -C "$RELEASE"
(cd "$RELEASE" && PATH="/opt/node/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
MERCHANT_FLAGS=""
if [ -n "$MERCHANT_OFFER" ]; then
  install -m 644 "$HERE/$MERCHANT_OFFER" /etc/calyptra/merchant-offer.json
  mkdir -p "$RELEASE/packages/framework/artifacts"
  tar -xzf "$HERE/artifacts.tgz" -C "$RELEASE/packages/framework/artifacts"
  MERCHANT_FLAGS=" --merchant --merchant-offer /etc/calyptra/merchant-offer.json"
fi
ln -sfn "$RELEASE" /opt/calyptra/current
ls -1dt /opt/calyptra/releases/* | tail -n +4 | xargs -r rm -rf

# 5. The node service. Both servers bind 127.0.0.1 and are reached only through Caddy; no --rpc here.
cat > /etc/systemd/system/calyptra-node.service <<UNIT
[Unit]
Description=Calyptra transaction relayer and libp2p relay (${NETWORK_ID})
After=network-online.target
Wants=network-online.target

[Service]
User=calyptra
EnvironmentFile=/etc/calyptra/node.env
WorkingDirectory=/opt/calyptra/current
ExecStart=/opt/node/bin/node apps/desktop/src/main.ts start --data-dir /var/lib/calyptra/node --network ${NETWORK_ID} --no-shell --log-level info --relayer --relayer-account ${RELAYER_ACCOUNT} --relayer-fee-native ${FEE_NATIVE} --relayer-fee-stablecoin ${FEE_STABLECOIN} --relayer-host 127.0.0.1 --relayer-port 8646 --libp2p-relay --libp2p-relay-host 127.0.0.1 --libp2p-relay-port 8647 --libp2p-relay-announce /dns4/${RELAY_HOST}/tcp/443/wss${MERCHANT_FLAGS}
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/calyptra
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# 6. Caddy: browsers' libp2p connections are WebSocket upgrades, everything else is the relayer's HTTP
# API (including POST /hyperrpc). No access log, so the relay host keeps no record of who connects.
cat > /etc/caddy/Caddyfile <<CADDY
${RELAY_HOST} {
	@libp2p header Upgrade websocket
	reverse_proxy @libp2p 127.0.0.1:8647
	reverse_proxy 127.0.0.1:8646
}
CADDY

# 7. Start.
systemctl daemon-reload
systemctl enable calyptra-node caddy
systemctl restart calyptra-node
systemctl reload caddy || systemctl restart caddy
echo "installed release ${RELEASE_ID}"
