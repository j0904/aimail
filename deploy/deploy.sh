#!/usr/bin/env bash
# deploy.sh — Deploy aimail (DIDComm mediator) to target server
#
# Prerequisite: deploy/deploydb.sh must have been run first.
#
# Usage:
#   ./deploy.sh                    # Deploy to s1001.bigt.ai (default)
#   ./deploy.sh <server hostname>  # Deploy to custom server
#   ./deploy.sh --local            # Deploy to local Docker (no SSH)
#   ./deploy.sh --status           # Health check remote deployment
#
# Required env vars:
#   AIMAIL_KEY_PASSPHRASE   AES-256-GCM key for mediator secrets at rest
#   PGPASSWORD              Postgres password (must match deploydb.sh)
#
# Optional overrides:
#   PGUSER                  Postgres user (default: aimail)
#   PGDATABASE              Postgres database (default: aimail)
#   PGHOST                  Postgres host (default: host.docker.internal → localhost:5435)
#   PGPORT                  Postgres port (default: 5435)
#   SSH_KEY_PATH            SSH private key (default: ~/.ssh/oraclevpc.key)
#   SSH_USER                SSH user (default: root)
#   REGISTRY                Docker registry (default: ghcr.io/bigt-ai-platform/aimail)
#   IMAGE_TAG               Image tag (default: latest)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ─── Defaults ────────────────────────────────────────────────────────────────
DEFAULT_SERVER="s1001.bigt.ai"
SSH_KEY="${SSH_KEY_PATH:-$HOME/.ssh/oraclevpc.key}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes)
[ -f "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

REGISTRY="${REGISTRY:-ghcr.io/bigt-ai-platform/aimail}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="${REGISTRY}:${IMAGE_TAG}"

PGUSER="${PGUSER:-aimail}"
PGDATABASE="${PGDATABASE:-aimail}"
PGHOST="${PGHOST:-host.docker.internal}"
PGPORT="${PGPORT:-5435}"

COMPOSE_NAME="docker-compose.aimail.yml"
COMPOSE_DIR="/data/vm/aimail"
CONTAINER_APP="aimail"
DATA_DB="/data/vm/aimail-db"

# ─── Parse args ──────────────────────────────────────────────────────────────
LOCAL_MODE=false
TARGET_SERVER="$DEFAULT_SERVER"

case "${1:-}" in
  --local) LOCAL_MODE=true ;;
  --status|--health) ;;      # flag, not server
  --help|-h) ;;              # flag
  "") ;;                     # no arg, use default
  *)  TARGET_SERVER="$1" ;;  # custom server
esac

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[aimail]${NC} $*"; }
warn() { echo -e "${YELLOW}[aimail]${NC} $*"; }
err()  { echo -e "${RED}[aimail]${NC} $*"; exit 1; }

# ─── Validate env ────────────────────────────────────────────────────────────
validate_env() {
  if [ -z "${AIMAIL_KEY_PASSPHRASE:-}" ]; then
    err "AIMAIL_KEY_PASSPHRASE is required. Generate: openssl rand -base64 32"
  fi
  if [ -z "${PGPASSWORD:-}" ]; then
    err "PGPASSWORD is required (must match deploydb.sh)."
  fi
  log "Environment validated."
}

# ─── SSH helpers ─────────────────────────────────────────────────────────────
ssh_exec() {
  if [ "$LOCAL_MODE" = true ]; then
    bash -c "$*"
  else
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${TARGET_SERVER}" "$@"
  fi
}

scp_file() {
  if [ "$LOCAL_MODE" = true ]; then
    cp "$1" "$2"
  else
    scp "${SSH_OPTS[@]}" "$1" "${SSH_USER}@${TARGET_SERVER}:$2"
  fi
}

# ─── Build ───────────────────────────────────────────────────────────────────
build_image() {
  log "Building aimail Docker image..."
  cd "$PROJECT_DIR"

  docker build --target production -t "$IMAGE" .
  log "Image built: $IMAGE"
}

# ─── Push to registry (CI does this on git push; manual override) ────────────
push_image() {
  log "Pushing $IMAGE to registry..."
  docker push "$IMAGE"
  log "Image pushed."
}

# ─── Remote deploy ───────────────────────────────────────────────────────────
deploy_remote() {
  validate_env

  log "Deploying aimail app to ${TARGET_SERVER}..."
  log "  DB:   ${PGHOST}:${PGPORT}/${PGDATABASE} (user: ${PGUSER})"
  log "  Image: ${IMAGE}"

  # 1. Verify DB is reachable
  log "Checking aimail-db is running..."
  if ! ssh_exec "docker exec aimail-db pg_isready -U ${PGUSER}" >/dev/null 2>&1; then
    err "aimail-db not running. Run deploy/deploydb.sh first."
  fi
  log "aimail-db is ready."

  # 2. Create dirs and upload compose
  ssh_exec "mkdir -p ${COMPOSE_DIR}"
  scp_file "$SCRIPT_DIR/docker-compose.yml" "${COMPOSE_DIR}/${COMPOSE_NAME}"

  # 3. Write .env file (docker compose auto-loads this)
  log "Writing .env..."
  cat <<ENVEOF | ssh "${SSH_OPTS[@]}" "${SSH_USER}@${TARGET_SERVER}" "cat > ${COMPOSE_DIR}/.env"
AIMAIL_KEY_PASSPHRASE=${AIMAIL_KEY_PASSPHRASE}
PGUSER=${PGUSER}
PGPASSWORD=${PGPASSWORD}
PGDATABASE=${PGDATABASE}
PGHOST=${PGHOST}
PGPORT=${PGPORT}
AIMAIL_PG_SCHEMA=${AIMAIL_PG_SCHEMA:-public}

# Connection URL (for reference)
DATABASE_URL=postgresql://${PGUSER}:${PGPASSWORD}@${TARGET_SERVER}:5435/${PGDATABASE}?sslmode=require
ENVEOF
  ssh_exec "chmod 600 ${COMPOSE_DIR}/.env"

  # 4. Pull and start
  log "Pulling image..."
  ssh_exec "docker pull ${IMAGE} || true"

  log "Starting aimail..."
  ssh_exec "cd ${COMPOSE_DIR} && docker compose -f ${COMPOSE_NAME} down --remove-orphans 2>/dev/null || true"
  ssh_exec "cd ${COMPOSE_DIR} && docker compose -f ${COMPOSE_NAME} up -d"

  # 5. Wait for healthy
  log "Waiting for aimail to be healthy..."
  for i in $(seq 1 15); do
    if ssh_exec "curl -sf http://localhost:3080/api/health" >/dev/null 2>&1; then
      log "aimail is healthy!"
      break
    fi
    log "  Waiting... ($i/15)"
    sleep 3
  done

  # 6. Caddy
  log "Configuring Caddy for aimail.bigt.ai..."
  scp_file "$SCRIPT_DIR/Caddyfile.aimail" "/etc/caddy/Caddyfile.d/aimail.caddy"
  ssh_exec "caddy fmt --overwrite /etc/caddy/Caddyfile.d/aimail.caddy || true"
  ssh_exec "caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || systemctl reload caddy 2>/dev/null || true"

  # 7. Verify
  sleep 2
  ssh_exec "docker ps --filter name=${CONTAINER_APP} --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

  if curl -sf "https://aimail.bigt.ai/api/health" >/dev/null 2>&1; then
    log "Public endpoint: https://aimail.bigt.ai/api/health"
  else
    warn "Public endpoint not yet reachable (DNS may be propagating)"
  fi

  log ""
  log "Deploy complete!"
  log "  Health:    https://aimail.bigt.ai/api/health"
  log "  Mediator:  https://aimail.bigt.ai/api/mediator"
}

# ─── Local deploy ────────────────────────────────────────────────────────────
deploy_local() {
  validate_env

  log "Deploying aimail locally..."
  cd "$PROJECT_DIR"

  # Use project-level compose (includes DB + app)
  AIMAIL_KEY_PASSPHRASE="${AIMAIL_KEY_PASSPHRASE}" \
  PGPASSWORD="${PGPASSWORD}" \
    docker compose -f docker-compose.yml up -d --build

  log "Local deploy complete!"
  log "  Health:    http://localhost:3080/api/health"
  log "  Mediator:  http://localhost:3080/api/mediator"
}

# ─── Status ──────────────────────────────────────────────────────────────────
check_status() {
  log "Checking aimail on ${TARGET_SERVER}..."

  local health
  health=$(ssh_exec "curl -sf http://localhost:3080/api/health" 2>/dev/null || echo '{"status":"down"}')
  log "  Health: $health"

  ssh_exec "docker ps --filter name=${CONTAINER_APP} --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
}

# ─── Main ────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --local)
    validate_env
    build_image
    deploy_local
    ;;
  --push)
    build_image
    push_image
    ;;
  --status|--health)
    check_status
    ;;
  --help|-h)
    echo "Usage: $0 [server|--local|--push|--status|--help]"
    echo ""
    echo "  (no args)        Pull from GHCR and deploy to s1001.bigt.ai"
    echo "  <server>         Deploy to custom server"
    echo "  --local          Build locally and run via docker compose"
    echo "  --push           Build image locally and push to GHCR"
    echo "  --status         Check health of remote deployment"
    echo ""
    echo "CI builds the image on git push. deploy.sh only pulls from GHCR."
    echo "Use --push to manually push a locally-built image to the registry."
    echo ""
    echo "Prerequisite: deploy/deploydb.sh must have been run first on the target server."
    echo ""
    echo "Required env vars:"
    echo "  AIMAIL_KEY_PASSPHRASE   AES-256 key for mediator secrets"
    echo "  PGPASSWORD              Postgres password (must match deploydb.sh)"
    echo ""
    echo "Data layout on server:"
    echo "  Compose:   ${COMPOSE_DIR}/${COMPOSE_NAME}"
    echo "  Env:       ${COMPOSE_DIR}/.env"
    echo "  DB:        deploydb.sh handles ${DATA_DB}/"
    exit 0
    ;;
  *)
    validate_env
    deploy_remote
    ;;
esac
