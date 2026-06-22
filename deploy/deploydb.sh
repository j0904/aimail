#!/usr/bin/env bash
# deploydb.sh — Deploy aimail's dedicated PostgreSQL database to target server
#
# Usage:
#   ./deploydb.sh              # Deploy to s1001.bigt.ai (default)
#   ./deploydb.sh <server>     # Deploy to custom server
#   ./deploydb.sh status       # Show DB status
#   ./deploydb.sh renew-certs  # Renew SSL certs and restart
#
# Mirrors ../bigtai/deploy/deploydb.sh pattern exactly.
# Data root: /data/vm/aimail-db/
#
# Required env vars:
#   PGPASSWORD                     Postgres password (default: aimail_password)
#
# Optional overrides:
#   PGUSER                         Postgres user (default: aimail)
#   PGDATABASE                     Postgres database (default: aimail)
#   SSH_KEY_PATH                   SSH private key (default: ~/.ssh/oraclevpc.key)
#   SSH_USER                       SSH user (default: root)
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TARGET_VM="${1:-s1001.bigt.ai}"
SSH_KEY="${SSH_KEY_PATH:-${HOME}/.ssh/oraclevpc.key}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o IdentitiesOnly=yes"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "${SSH_KEY}" ]; then
  echo -e "${RED}Error: SSH key not found at ${SSH_KEY}${NC}"
  exit 1
fi

CONTAINER_NAME="aimail-db"
DB_USER="${PGUSER:-aimail}"
DB_PASSWORD="${PGPASSWORD:-aimail_password}"
DB_NAME="${PGDATABASE:-aimail}"
PGPORT_MAP="${PGPORT_MAP:-5435}"
COMPOSE_APP_DIR="/data/vm/aimail"

setup_certs() {
  echo -e "${YELLOW}Setting up SSL certificates...${NC}"

  scp ${SSH_OPTS} -i "${SSH_KEY}" "${SCRIPT_DIR}/pg-certs.sh" ${SSH_USER}@${TARGET_VM}:/tmp/
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} "bash /tmp/pg-certs.sh"

  echo -e "${GREEN}SSL certificates ready${NC}"
}

deploy_db() {
  echo -e "\n${GREEN}=== Deploying aimail PostgreSQL to ${TARGET_VM} ===${NC}"

  echo "Testing SSH..."
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} "echo OK" 2>&1 | head -1 || { echo -e "${RED}SSH failed${NC}"; exit 1; }

  setup_certs

  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} \
    "mkdir -p /data/vm/${CONTAINER_NAME}/data /data/vm/${CONTAINER_NAME}/certs"

  scp ${SSH_OPTS} -i "${SSH_KEY}" "${SCRIPT_DIR}/pg.conf" \
    ${SSH_USER}@${TARGET_VM}:/data/vm/${CONTAINER_NAME}/postgresql.conf

  echo -e "${YELLOW}Generating database docker-compose...${NC}"

  cat > /tmp/aimail-compose-db.yml << ENDCOMPOSE
services:
  postgres:
    image: postgres:16-alpine
    container_name: ${CONTAINER_NAME}
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - /data/vm/${CONTAINER_NAME}/data:/var/lib/postgresql/data
      - /data/vm/${CONTAINER_NAME}/postgresql.conf:/etc/postgresql/postgresql.conf:ro
      - /data/vm/${CONTAINER_NAME}/certs:/etc/ssl/postgresql:ro
    ports:
      - "0.0.0.0:${PGPORT_MAP}:5432"
    command: postgres -c config_file=/etc/postgresql/postgresql.conf
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
ENDCOMPOSE

  scp ${SSH_OPTS} -i "${SSH_KEY}" /tmp/aimail-compose-db.yml \
    ${SSH_USER}@${TARGET_VM}:/data/vm/aimail-db/docker-compose.db.yml
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} "mkdir -p /data/vm/aimail-db /data/vm/aimail"

  echo -e "${YELLOW}Starting database container...${NC}"
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} << 'ENDSSH'
    cd /data/vm/aimail-db
    docker compose -f docker-compose.db.yml down --remove-orphans 2>/dev/null || true
    docker compose -f docker-compose.db.yml up -d
    sleep 5
    echo ""
    echo "=== Database status ==="
    docker ps --filter "name=aimail-db" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
ENDSSH

  echo -e "${YELLOW}Waiting for database to be ready...${NC}"
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} << 'ENDSSH'
    for i in $(seq 1 12); do
      if docker exec aimail-db pg_isready -U aimail >/dev/null 2>&1; then
        echo "Database ready"
        break
      fi
      echo "Waiting... ($i/12)"
      sleep 5
    done
ENDSSH

  echo -e "\n${GREEN}=== Database deployment complete ===${NC}"
  echo -e "DB:     postgresql://${DB_USER}:****@${TARGET_VM}:${PGPORT_MAP}/${DB_NAME}?sslmode=require"
  echo -e "User:   ${DB_USER}"
  echo -e "Data:   /data/vm/${CONTAINER_NAME}/data"
  echo -e ""
  echo -e "Next:   cd deploy && AIMAIL_KEY_PASSPHRASE=... PGPASSWORD=${DB_PASSWORD} ./deploy.sh"
}

show_db_status() {
  echo -e "\n${GREEN}=== Database Status: ${TARGET_VM} ===${NC}"
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} << 'ENDSSH'
    docker ps --filter "name=aimail-db" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    docker exec aimail-db pg_isready -U aimail 2>&1 || echo "DB not ready"
ENDSSH
}

renew_certs() {
  echo -e "${YELLOW}Renewing SSL certificates...${NC}"
  ssh ${SSH_OPTS} -i "${SSH_KEY}" ${SSH_USER}@${TARGET_VM} \
    "certbot renew --quiet 2>/dev/null || true && \
     if [ -f /etc/letsencrypt/live/${TARGET_VM}/fullchain.pem ]; then \
       cp /etc/letsencrypt/live/${TARGET_VM}/fullchain.pem /data/vm/${CONTAINER_NAME}/certs/server.crt && \
       cp /etc/letsencrypt/live/${TARGET_VM}/privkey.pem   /data/vm/${CONTAINER_NAME}/certs/server.key && \
       chmod 600 /data/vm/${CONTAINER_NAME}/certs/server.key && \
       chown 70:70 /data/vm/${CONTAINER_NAME}/certs/server.crt /data/vm/${CONTAINER_NAME}/certs/server.key 2>/dev/null || true && \
       docker restart ${CONTAINER_NAME} && \
       echo 'Certs renewed and aimail-db restarted.'; \
     else \
       echo 'No renewed certs found — skipping.'; \
     fi"
  echo -e "${GREEN}Done${NC}"
}

main() {
  local ACTION="${1:-deploy}"

  # If first arg is not a known action, treat it as a custom server hostname
  case "${ACTION}" in
    deploy)
      deploy_db
      ;;
    status)
      show_db_status
      ;;
    renew-certs)
      renew_certs
      ;;
    -h|--help)
      echo "Usage: $0 [deploy|status|renew-certs|<server>]"
      echo ""
      echo "  deploy          Deploy DB to s1001.bigt.ai (default)"
      echo "  <server>        Deploy DB to custom server"
      echo "  status          Show database status"
      echo "  renew-certs     Renew SSL certificates"
      echo ""
      echo "Env: PGPASSWORD (default: aimail_password)"
      exit 0
      ;;
    *)
      # Treat as custom server
      TARGET_VM="$ACTION"
      deploy_db
      ;;
  esac

  echo -e "\n${GREEN}Done!${NC}"
}

main "$@"
