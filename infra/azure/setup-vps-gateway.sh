#!/usr/bin/env bash
# Bootstrap the Artemis chat gateway on the cutline-vps Azure VM.
# Run this script once via SSH or az vm run-command invoke.
#
# What it does:
#   1. Installs Python 3.12, pip, nginx, certbot, PostgreSQL
#   2. Clones the repo or pulls latest
#   3. Installs Python gateway dependencies
#   4. Creates the artemis_chat PostgreSQL database and user
#   5. Writes /etc/artemis-chat.env with environment variables
#   6. Installs artemis-chat.service and starts it
#   7. Configures nginx reverse proxy with Let's Encrypt TLS
#
# Required env vars (pass before running):
#   DOMAIN          - gateway hostname, e.g. api.artemis-ai.net
#   DB_PASSWORD     - password for artemis_chat Postgres user
#   VLLM_BASE_URL   - Artemis inference endpoint (same-server http://127.0.0.1:8000 if local)
#   VLLM_MODEL      - model name served by vLLM (e.g. artemis)
#   VLLM_API_KEY    - API key for vLLM endpoint (or empty for local)
#   REPO_URL        - git clone URL (default: https://github.com/lpittman-g/Cutline-Industries)
#   LETSENCRYPT_EMAIL - email for certbot (e.g. lpittman@cutline-industries.studio)
#
# Usage (from your local machine via SSH):
#   export DOMAIN=api.artemis-ai.net DB_PASSWORD=... VLLM_BASE_URL=... VLLM_MODEL=artemis LETSENCRYPT_EMAIL=...
#   ssh azureuser@172.203.229.191 "$(cat infra/azure/setup-vps-gateway.sh)"
#
# Or via az vm run-command (requires Azure CLI):
#   az vm run-command invoke -g artm-rg -n cutline-vps \
#     --command-id RunShellScript \
#     --scripts @infra/azure/setup-vps-gateway.sh

set -euo pipefail

DOMAIN="${DOMAIN:-api.artemis-ai.net}"
# Browser origins allowed to call the gateway. These are the SITES, which are not
# the same host as $DOMAIN — $DOMAIN is the API itself and never originates a
# request. An earlier version derived this from $DOMAIN and produced
# https://www.api.cutline-industries.studio, an origin nothing serves.
SITE_ORIGINS="${SITE_ORIGINS:-https://cutline-industries.studio,https://www.cutline-industries.studio,https://artemisai-bycutlineindustries.studio,https://www.artemisai-bycutlineindustries.studio}"
# Re-use existing DB password if the env file already exists; generate once otherwise
if [ -z "${DB_PASSWORD:-}" ] && [ -f /etc/artemis-chat.env ]; then
  DB_PASSWORD=$(grep '^ARTEMIS_DATABASE_URL=' /etc/artemis-chat.env | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|')
fi
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 40)}"
VLLM_BASE_URL="${VLLM_BASE_URL:-http://127.0.0.1:8000}"
VLLM_MODEL="${VLLM_MODEL:-artemis}"
VLLM_API_KEY="${VLLM_API_KEY:-}"
REPO_URL="${REPO_URL:-https://github.com/lpittman-g/Cutline-Industries}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-lpittman@cutline-industries.studio}"
APP_DIR=/opt/artemis-chat
APP_USER=artemis

echo "[setup] Installing system packages…"
export DEBIAN_FRONTEND=noninteractive
# Wait for any concurrent apt operations to finish
for _i in $(seq 1 24); do
  fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break
  sleep 5
done
apt-get update -qq
apt-get install -y -qq software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt-get update -qq
apt-get install -y -qq \
  python3.12 python3.12-venv python3-pip \
  postgresql postgresql-contrib \
  nginx certbot python3-certbot-nginx \
  git curl

echo "[setup] Creating app user and directory…"
id "$APP_USER" &>/dev/null || useradd -r -U -s /bin/false -d "$APP_DIR" "$APP_USER"
# `useradd -r` WITHOUT -U does not create a matching group on Debian/Ubuntu: the
# account lands in `users` (gid 100), the group every human account shares. Two
# consequences, both real — this ran on Ubuntu 24.04 and failed:
#   1. `chown artemis:artemis` below exits 1, "invalid group", aborting setup.
#   2. Anything group-readable under $APP_DIR would be readable by every member
#      of `users`, which is not what a service account is for.
# Create the group and make it primary, repairing an account left behind by an
# earlier run of this script as well as a fresh one.
getent group "$APP_USER" >/dev/null || groupadd -r "$APP_USER"
usermod -g "$APP_USER" "$APP_USER"
mkdir -p "$APP_DIR"

echo "[setup] Cloning/pulling repo…"
git config --system --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "[setup] Creating Python venv and installing deps…"
sudo -u "$APP_USER" python3.12 -m venv "$APP_DIR/.venv"
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --quiet \
  -r "$APP_DIR/gateway/requirements.txt"

echo "[setup] Setting up PostgreSQL…"
systemctl enable postgresql --now
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='artemis_chat'" | grep -q 1 \
  && sudo -u postgres psql -c "ALTER USER artemis_chat WITH PASSWORD '$DB_PASSWORD';" \
  || sudo -u postgres psql -c "CREATE USER artemis_chat WITH PASSWORD '$DB_PASSWORD';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='artemis_chat'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE artemis_chat OWNER artemis_chat;"

echo "[setup] Writing environment file…"
cat > /etc/artemis-chat.env <<ENV
PORT=8080
ARTEMIS_BIND=127.0.0.1
ARTEMIS_COOKIE_SECURE=1
ARTEMIS_ALLOWED_ORIGINS=${SITE_ORIGINS}
ARTEMIS_DATABASE_URL=postgresql://artemis_chat:${DB_PASSWORD}@127.0.0.1:5432/artemis_chat
VLLM_BASE_URL=${VLLM_BASE_URL}
VLLM_MODEL=${VLLM_MODEL}
VLLM_API_KEY=${VLLM_API_KEY}
ENV
chmod 600 /etc/artemis-chat.env
chown root:root /etc/artemis-chat.env

echo "[setup] Installing systemd service…"
cat > /etc/systemd/system/artemis-chat.service <<UNIT
[Unit]
Description=Artemis Chat Gateway
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/gateway
EnvironmentFile=/etc/artemis-chat.env
ExecStart=$APP_DIR/.venv/bin/python -m artemis.chat_app
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable artemis-chat
# Kill any stray process holding the port before (re)starting the service
fuser -k 8080/tcp 2>/dev/null || true
sleep 1
systemctl restart artemis-chat
sleep 3
systemctl is-active artemis-chat && echo "[setup] Gateway started OK" || { echo "[setup] Gateway failed to start"; journalctl -u artemis-chat -n 30; exit 1; }

echo "[setup] Configuring nginx…"
cat > /etc/nginx/sites-available/artemis-chat <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # SSE streaming
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        chunked_transfer_encoding on;
    }

    location /v1/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/artemis-chat /etc/nginx/sites-enabled/artemis-chat
nginx -t
systemctl reload nginx

echo "[setup] Obtaining TLS certificate with Let's Encrypt…"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect; then
  echo "[setup] TLS certificate issued OK"
else
  echo "[setup] WARNING: certbot failed (DNS not yet propagated?). Re-run once domain is live:"
  echo "  certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $LETSENCRYPT_EMAIL --redirect"
fi

echo ""
echo "====================================================="
echo " Gateway live at: https://$DOMAIN"
echo " Health check:    curl https://$DOMAIN/api/health"
echo "====================================================="
echo ""
# The password is NOT printed. It is generated on the host, written to
# /etc/artemis-chat.env (root-owned, 0600) and re-read from there on a re-run,
# so nothing needs it in a human's hands. Echoing it put the secret into
# terminal scrollback, CI logs, and — when this script is driven by
# `az vm run-command` — into the command output and whatever transcript
# captured it. That happened. Read it from the host if it is ever genuinely
# needed:
#   sudo grep '^ARTEMIS_DATABASE_URL=' /etc/artemis-chat.env
echo "Database credentials are in /etc/artemis-chat.env on the server (root, 0600)."
echo ""
echo "Next steps:"
echo "  1. Run infra/prepare-vercel.py --gateway-url https://$DOMAIN"
echo "  2. git add site/vercel.json && git commit && git push"
