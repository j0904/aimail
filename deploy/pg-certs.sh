#!/usr/bin/env bash
# pg-certs.sh — Copy TLS certs into /data/vm/aimail-db/certs/
# Runs on the server during deploy.
#
# Priority:
#   1. Reuse Caddy's auto-obtained LE certs for s1001.bigt.ai (or $CERT_DOMAIN)
#   2. Fallback: certbot certonly --standalone
#
# Expected env vars:
#   CERT_DOMAIN  — domain to issue certs for (default: s1001.bigt.ai)
#
set -euo pipefail

DOMAIN="${CERT_DOMAIN:-s1001.bigt.ai}"
CERT_DIR="/data/vm/aimail-db/certs"
mkdir -p "$CERT_DIR"

# Try Caddy certs first
CADDY_STORAGE="/var/lib/caddy/.local/share/caddy"
CADDY_CERTS="$CADDY_STORAGE/certificates"

if [ -d "$CADDY_CERTS" ]; then
  CRT=$(find "$CADDY_CERTS" -name "${DOMAIN}.crt" 2>/dev/null | head -1)
  KEY=$(find "$CADDY_CERTS" -name "${DOMAIN}.key" 2>/dev/null | head -1)

  if [ -n "$CRT" ] && [ -n "$KEY" ]; then
    cp "$CRT" "$CERT_DIR/server.crt"
    cp "$KEY" "$CERT_DIR/server.key"
    chmod 600 "$CERT_DIR/server.key"
    chown 70:70 "$CERT_DIR/server.crt" "$CERT_DIR/server.key" 2>/dev/null || true
    echo "[aimail-pg-certs] Copied Caddy certs for $DOMAIN"
    exit 0
  fi
fi

# Fallback: certbot standalone
echo "[aimail-pg-certs] Caddy certs not found, using certbot for $DOMAIN..."
systemctl stop caddy 2>/dev/null || true

certbot certonly --standalone \
  --non-interactive --agree-tos \
  --email "admin@bigt.ai" \
  -d "$DOMAIN" \
  --keep-until-expiring 2>/dev/null || {
    echo "[aimail-pg-certs] certbot failed — starting caddy and continuing without TLS certs"
    systemctl start caddy 2>/dev/null || true
    exit 0
  }

cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/server.crt" 2>/dev/null || true
cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "$CERT_DIR/server.key" 2>/dev/null || true
chmod 600 "$CERT_DIR/server.key" 2>/dev/null || true
chown 70:70 "$CERT_DIR/server.crt" "$CERT_DIR/server.key" 2>/dev/null || true

systemctl start caddy 2>/dev/null || true
echo "[aimail-pg-certs] certbot certs copied for $DOMAIN"
