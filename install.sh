#!/usr/bin/env bash
set -Eeuo pipefail

# PaaSbyDeep — Ubuntu & Debian VPS Interactive Installer & Uninstaller

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

trap 'log_error "Script failed on line $LINENO. Check the output above."' ERR

if [[ "${EUID}" -ne 0 ]]; then
  log_error "Please run this script as root (e.g. sudo bash install.sh)."
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  log_error "Cannot detect OS (/etc/os-release missing). Ubuntu or Debian is required."
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
OS_ID="${ID,,}"
if [[ "$OS_ID" != "ubuntu" && "$OS_ID" != "debian" ]]; then
  log_error "Unsupported OS '$ID'. This script supports Ubuntu and Debian."
  exit 1
fi

if [[ ! -t 0 ]]; then
  log_error "Interactive terminal required for user prompts. Run with: sudo bash install.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAS_LOCAL_REPO="false"
if [[ -f "$SCRIPT_DIR/Backend/package.json" && -f "$SCRIPT_DIR/Frontend/package.json" ]]; then
  HAS_LOCAL_REPO="true"
fi

MODE=""
for arg in "$@"; do
  case "$arg" in
    --uninstall|-u) MODE="uninstall" ;;
    --install|-i)   MODE="install" ;;
    --help|-h)
      echo "Usage: sudo bash install.sh [--install | --uninstall]"
      exit 0
      ;;
  esac
done

echo -e "${CYAN}"
cat <<'BANNER'
============================================================
         PaaSbyDeep — Ubuntu / Debian VPS Setup
============================================================
BANNER
echo -e "${NC}"
log_info "Detected OS: ${PRETTY_NAME:-$ID}"

if [[ -z "$MODE" ]]; then
  echo ""
  echo "Choose an action:"
  echo "  1) Install / Update PaaSbyDeep"
  echo "  2) Uninstall PaaSbyDeep (remove services, containers, Nginx configs & data)"
  action_choice=""
  while [[ "$action_choice" != "1" && "$action_choice" != "2" ]]; do
    read -r -p "Select option [1]: " action_choice
    action_choice="${action_choice:-1}"
  done
  if [[ "$action_choice" == "2" ]]; then
    MODE="uninstall"
  else
    MODE="install"
  fi
fi

# ============================================================
# UNINSTALL MODE
# ============================================================
run_uninstall() {
  local DEFAULT_DIR="/opt/paasbydeeep"
  if [[ "$HAS_LOCAL_REPO" == "true" ]]; then
    DEFAULT_DIR="$SCRIPT_DIR"
  fi

  echo ""
  read -r -p "PaaSbyDeep install directory to remove [${DEFAULT_DIR}]: " UNINSTALL_DIR
  UNINSTALL_DIR="${UNINSTALL_DIR:-$DEFAULT_DIR}"
  UNINSTALL_DIR="${UNINSTALL_DIR%/}"

  if [[ -z "$UNINSTALL_DIR" || "$UNINSTALL_DIR" == "/" || "$UNINSTALL_DIR" == "/root" || "$UNINSTALL_DIR" == "/home" || "$UNINSTALL_DIR" == "/opt" || "$UNINSTALL_DIR" == "/var" || "$UNINSTALL_DIR" == "/etc" || "$UNINSTALL_DIR" == "/usr" ]]; then
    log_error "Refusing unsafe uninstall path: '${UNINSTALL_DIR}'."
    exit 1
  fi

  echo -e "${YELLOW}WARNING: This will stop PaaSbyDeep, delete all paasbydeeep-* Docker containers/images, Nginx site configs, logs, /var/www/paasbydeeep, and ${UNINSTALL_DIR}.${NC}"
  read -r -p "Type 'uninstall' to confirm: " confirm_text
  if [[ "$confirm_text" != "uninstall" ]]; then
    log_info "Uninstall cancelled."
    exit 0
  fi

  # Collect configured domains & DB URL before deleting files
  local ENV_FILE="${UNINSTALL_DIR}/Backend/.env"
  local COLLECTED_DOMAINS=()
  local DB_URL=""

  if [[ -f "$ENV_FILE" ]] && command -v node >/dev/null 2>&1; then
    DB_URL="$(node -e "
      const fs = require('fs');
      const lines = fs.readFileSync(process.argv[1], 'utf8').split(/\r?\n/);
      for (const l of lines) {
        if (l.startsWith('DATABASE_URL=')) {
          process.stdout.write(l.slice('DATABASE_URL='.length).trim());
          break;
        }
      }
    " "$ENV_FILE" 2>/dev/null || true)"

    if [[ -d "${UNINSTALL_DIR}/Backend/node_modules" ]]; then
      mapfile -t DB_DOMAINS < <(
        cd "${UNINSTALL_DIR}/Backend" && node --input-type=module -e "
          import './src/config/env.js';
          import { initDb, getDb, closeDb } from './src/db/database.js';
          try {
            await initDb();
            const sql = getDb();
            const d = await sql\`SELECT domain FROM domains\`.catch(() => []);
            const s = await sql\`SELECT dashboard_domain FROM platform_settings WHERE id = 1\`.catch(() => []);
            const all = new Set(d.map(r => r.domain).filter(Boolean));
            if (s[0]?.dashboard_domain) all.add(s[0].dashboard_domain);
            for (const dom of all) console.log(dom);
            await closeDb();
          } catch {}
        " 2>/dev/null || true
      )
      for d in "${DB_DOMAINS[@]:-}"; do
        [[ -n "$d" ]] && COLLECTED_DOMAINS+=("$d")
      done
    fi
  fi

  # Also scan Nginx configs named paasbydeeep-*.conf
  shopt -s nullglob
  for cfg in /etc/nginx/sites-available/paasbydeeep-*.conf; do
    local dom_name
    dom_name="$(basename "$cfg" | sed -E 's/^paasbydeeep-//; s/\.conf$//')"
    [[ -n "$dom_name" ]] && COLLECTED_DOMAINS+=("$dom_name")
  done
  shopt -u nullglob

  # Deduplicate domains
  local UNIQUE_DOMAINS=()
  if (( ${#COLLECTED_DOMAINS[@]} > 0 )); then
    mapfile -t UNIQUE_DOMAINS < <(printf '%s\n' "${COLLECTED_DOMAINS[@]}" | awk '!seen[$0]++')
  fi

  # 1. Stop & remove PM2 process
  if command -v pm2 >/dev/null 2>&1; then
    log_info "Stopping PM2 service paasbydeeep-backend..."
    pm2 stop paasbydeeep-backend >/dev/null 2>&1 || true
    pm2 delete paasbydeeep-backend >/dev/null 2>&1 || true
    pm2 save --force >/dev/null 2>&1 || true

    local remaining_pm2
    remaining_pm2="$(pm2 jlist 2>/dev/null || echo '[]')"
    if [[ "$remaining_pm2" == "[]" ]]; then
      pm2 unstartup systemd >/dev/null 2>&1 || true
    fi
    log_ok "PM2 service removed."
  fi

  # 2. Remove PaaSbyDeep Docker containers and images
  if command -v docker >/dev/null 2>&1; then
    log_info "Removing PaaSbyDeep Docker containers and images..."
    mapfile -t PAAS_CONTAINERS < <(docker ps -aq --filter "name=^paasbydeeep-" 2>/dev/null || true)
    if (( ${#PAAS_CONTAINERS[@]} > 0 )); then
      docker rm -f "${PAAS_CONTAINERS[@]}" >/dev/null 2>&1 || true
    fi

    mapfile -t PAAS_IMAGES < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^paasbydeeep-' || true)
    if (( ${#PAAS_IMAGES[@]} > 0 )); then
      docker rmi -f "${PAAS_IMAGES[@]}" >/dev/null 2>&1 || true
    fi
    log_ok "Docker containers and images cleaned up."
  fi

  # 3. Remove Nginx site configurations & logs BEFORE deleting Certbot certs
  log_info "Removing Nginx configurations for PaaSbyDeep..."
  rm -f /etc/nginx/sites-enabled/paasbydeeep /etc/nginx/sites-enabled/paasbydeeep-*.conf
  rm -f /etc/nginx/sites-available/paasbydeeep /etc/nginx/sites-available/paasbydeeep-*.conf
  rm -f /var/log/nginx/paasbydeeep*.log
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || true
    else
      log_warn "nginx -t reported issues after config cleanup; check /etc/nginx/sites-enabled."
    fi
  fi
  log_ok "Nginx configurations removed."

  # 4. Remove Certbot SSL certificates for PaaSbyDeep domains
  if (( ${#UNIQUE_DOMAINS[@]} > 0 )) && command -v certbot >/dev/null 2>&1; then
    echo ""
    read -r -p "Delete Let's Encrypt SSL certificates for (${UNIQUE_DOMAINS[*]})? [Y/n]: " del_certs
    del_certs="${del_certs:-Y}"
    if [[ "${del_certs,,}" == "y" || "${del_certs,,}" == "yes" ]]; then
      for dom in "${UNIQUE_DOMAINS[@]}"; do
        if [[ -d "/etc/letsencrypt/live/${dom}" ]]; then
          certbot delete --non-interactive --cert-name "$dom" >/dev/null 2>&1 || true
        fi
      done
      log_ok "Removed Certbot certificates for PaaSbyDeep domains."
    fi
  fi

  # 5. Clean up Database (Local PostgreSQL or External / Neon DB tables)
  if [[ -n "$DB_URL" ]] && command -v node >/dev/null 2>&1; then
    local DB_HOST="" DB_NAME="" DB_USER=""
    read -r DB_HOST DB_NAME DB_USER < <(
      node -e "
        try {
          const u = new URL(process.argv[1]);
          console.log(u.hostname, u.pathname.replace(/^\/+/, ''), decodeURIComponent(u.username || ''));
        } catch { console.log('', '', ''); }
      " "$DB_URL" 2>/dev/null || echo ""
    )

    if [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]]; then
      echo ""
      read -r -p "Drop local PostgreSQL database '${DB_NAME}' and role '${DB_USER}'? [Y/n]: " drop_local_db
      drop_local_db="${drop_local_db:-Y}"
      if [[ "${drop_local_db,,}" == "y" || "${drop_local_db,,}" == "yes" ]] && command -v psql >/dev/null 2>&1; then
        if [[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
          su - postgres -c "psql -v ON_ERROR_STOP=0 -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();\"" >/dev/null 2>&1 || true
          su - postgres -c "psql -v ON_ERROR_STOP=0 -c \"DROP DATABASE IF EXISTS ${DB_NAME};\"" >/dev/null 2>&1 || true
        fi
        if [[ "$DB_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && "$DB_USER" != "postgres" ]]; then
          su - postgres -c "psql -v ON_ERROR_STOP=0 -c \"DROP ROLE IF EXISTS ${DB_USER};\"" >/dev/null 2>&1 || true
        fi
        log_ok "Dropped local PostgreSQL database and role."
      fi

      read -r -p "Purge local PostgreSQL server packages too? [y/N]: " purge_pg
      if [[ "${purge_pg,,}" == "y" || "${purge_pg,,}" == "yes" ]]; then
        systemctl stop postgresql >/dev/null 2>&1 || true
        DEBIAN_FRONTEND=noninteractive apt-get purge -y 'postgresql*' >/dev/null 2>&1 || true
        apt-get autoremove -y >/dev/null 2>&1 || true
        rm -rf /etc/postgresql /var/lib/postgresql
        log_ok "PostgreSQL server purged."
      fi
    else
      echo ""
      read -r -p "Drop all PaaSbyDeep tables from external/Neon database (${DB_HOST})? [y/N]: " drop_ext_db
      if [[ "${drop_ext_db,,}" == "y" || "${drop_ext_db,,}" == "yes" ]] && [[ -d "${UNINSTALL_DIR}/Backend/node_modules" ]]; then
        (
          cd "${UNINSTALL_DIR}/Backend" && node --input-type=module -e "
            import './src/config/env.js';
            import { initDb, getDb, closeDb } from './src/db/database.js';
            await initDb();
            const sql = getDb();
            await sql\`DROP TABLE IF EXISTS domains, deployments, github_connections, applications, platform_settings, users CASCADE\`;
            await closeDb();
          "
        ) && log_ok "Dropped PaaSbyDeep tables from external database." || log_warn "Could not drop external tables automatically."
      fi
    fi
  fi

  # 6. Remove files, web root, and logs
  log_info "Removing web root, logs, and ${UNINSTALL_DIR}..."
  rm -rf /var/www/paasbydeeep /var/log/paasbydeeep
  if [[ -d "$UNINSTALL_DIR" ]]; then
    cd /
    rm -rf "$UNINSTALL_DIR"
  fi
  log_ok "Removed PaaSbyDeep files and directories."

  # 7. Optional cleanup of shared runtime packages
  echo ""
  read -r -p "Also uninstall PM2, Nginx, and Certbot packages from this VPS? [y/N]: " purge_pkgs
  if [[ "${purge_pkgs,,}" == "y" || "${purge_pkgs,,}" == "yes" ]]; then
    npm uninstall -g pm2 >/dev/null 2>&1 || true
    systemctl stop nginx >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get purge -y nginx 'nginx-*' certbot python3-certbot-nginx >/dev/null 2>&1 || true
    apt-get autoremove -y >/dev/null 2>&1 || true
    log_ok "Removed PM2, Nginx, and Certbot."
  fi

  read -r -p "Also uninstall Docker Engine from this VPS? [y/N]: " purge_docker
  if [[ "${purge_docker,,}" == "y" || "${purge_docker,,}" == "yes" ]]; then
    systemctl stop docker docker.socket >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get purge -y docker-ce docker-ce-cli containerd.io docker.io docker-compose-plugin >/dev/null 2>&1 || true
    apt-get autoremove -y >/dev/null 2>&1 || true
    log_ok "Removed Docker Engine."
  fi

  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}          PaaSbyDeep Uninstall Complete.${NC}"
  echo -e "${GREEN}============================================================${NC}"
  exit 0
}

if [[ "$MODE" == "uninstall" ]]; then
  run_uninstall
fi

# ============================================================
# INSTALL / UPDATE MODE
# ============================================================
DEFAULT_DIR="/opt/paasbydeeep"
if [[ "$HAS_LOCAL_REPO" == "true" ]]; then
  DEFAULT_DIR="$SCRIPT_DIR"
fi

read -r -p "Install directory [${DEFAULT_DIR}]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
INSTALL_DIR="${INSTALL_DIR%/}"

DEFAULT_REPO_URL="https://github.com/yashan223/PaaSbyDeep.git"
REPO_CLONE_URL=""
if [[ "$HAS_LOCAL_REPO" != "true" ]]; then
  read -r -p "Git repository URL [${DEFAULT_REPO_URL}]: " REPO_CLONE_URL
  REPO_CLONE_URL="${REPO_CLONE_URL:-$DEFAULT_REPO_URL}"
fi

read -r -p "Backend API port [3001]: " APP_PORT
APP_PORT="${APP_PORT:-3001}"
if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || (( APP_PORT < 1024 || APP_PORT > 65535 )); then
  log_error "Port must be an integer between 1024 and 65535."
  exit 1
fi

echo ""
echo "Select database setup:"
echo "  1) Install & configure local PostgreSQL on this VPS (recommended)"
echo "  2) Connect existing Neon DB or external PostgreSQL URL"
DB_CHOICE=""
while [[ "$DB_CHOICE" != "1" && "$DB_CHOICE" != "2" ]]; do
  read -r -p "Choose option [1]: " DB_CHOICE
  DB_CHOICE="${DB_CHOICE:-1}"
done

PG_DB_NAME="paasbydeeep"
PG_DB_USER="paasbydeeep"
PG_DB_PASS=""
DATABASE_URL=""
DB_DRIVER="auto"

if [[ "$DB_CHOICE" == "1" ]]; then
  read -r -p "PostgreSQL database name [${PG_DB_NAME}]: " input_db
  PG_DB_NAME="${input_db:-$PG_DB_NAME}"
  if ! [[ "$PG_DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    log_error "Invalid database name. Use letters, numbers, and underscores only."
    exit 1
  fi

  read -r -p "PostgreSQL username [${PG_DB_USER}]: " input_user
  PG_DB_USER="${input_user:-$PG_DB_USER}"
  if ! [[ "$PG_DB_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    log_error "Invalid database username. Use letters, numbers, and underscores only."
    exit 1
  fi

  read -r -s -p "PostgreSQL password [leave blank to auto-generate]: " PG_DB_PASS
  echo ""
  DB_DRIVER="pg"
else
  while true; do
    read -r -p "Paste PostgreSQL / Neon DATABASE_URL (postgresql://...): " DATABASE_URL
    if [[ "$DATABASE_URL" =~ ^postgres(ql)?://.+/.+ ]]; then
      break
    fi
    log_warn "Invalid format. Expected postgresql://USER:PASSWORD@HOST/DBNAME"
  done
  DB_DRIVER="auto"
fi

echo ""
while true; do
  read -r -p "Dashboard admin username [admin]: " ADMIN_USERNAME
  ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
  if [[ "$ADMIN_USERNAME" =~ ^[a-zA-Z0-9._-]{3,40}$ ]]; then
    break
  fi
  log_warn "Username must be 3-40 characters (letters, numbers, dot, underscore, hyphen)."
done

ADMIN_PASS_AUTOGEN="false"
while true; do
  read -r -s -p "Dashboard admin password (min 8 chars, blank to auto-generate): " ADMIN_PASSWORD
  echo ""
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASS_AUTOGEN="true"
    break
  fi
  if (( ${#ADMIN_PASSWORD} < 8 || ${#ADMIN_PASSWORD} > 128 )); then
    log_warn "Password must be between 8 and 128 characters."
    continue
  fi
  read -r -s -p "Confirm dashboard admin password: " ADMIN_PASSWORD_CONFIRM
  echo ""
  if [[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]]; then
    break
  fi
  log_warn "Passwords do not match. Please try again."
done

echo ""
read -r -p "Dashboard domain (e.g. paas.example.com, leave blank for VPS IP HTTP): " DASHBOARD_DOMAIN
DASHBOARD_DOMAIN="$(echo "${DASHBOARD_DOMAIN:-}" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##; s/[[:space:]]//g')"

INSTALL_SSL="false"
CERTBOT_EMAIL=""
if [[ -n "$DASHBOARD_DOMAIN" ]]; then
  read -r -p "Install Let's Encrypt SSL via Certbot for ${DASHBOARD_DOMAIN}? [Y/n]: " ssl_ans
  ssl_ans="${ssl_ans:-Y}"
  if [[ "${ssl_ans,,}" == "y" || "${ssl_ans,,}" == "yes" ]]; then
    INSTALL_SSL="true"
    while [[ -z "$CERTBOT_EMAIL" || "$CERTBOT_EMAIL" != *"@"* ]]; do
      read -r -p "Certbot Let's Encrypt email address: " CERTBOT_EMAIL
    done
  fi
else
  read -r -p "Default Certbot email for future app domains (optional): " CERTBOT_EMAIL
fi

echo ""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
read -r -p "Configure GitHub OAuth App credentials now? (PAT works without this) [y/N]: " oauth_ans
if [[ "${oauth_ans,,}" == "y" || "${oauth_ans,,}" == "yes" ]]; then
  read -r -p "GitHub OAuth Client ID: " GITHUB_CLIENT_ID
  read -r -s -p "GitHub OAuth Client Secret: " GITHUB_CLIENT_SECRET
  echo ""
fi

CONFIGURE_UFW="false"
if command -v ufw >/dev/null 2>&1; then
  read -r -p "Allow ports 22, 80, 443 in UFW firewall? [Y/n]: " ufw_ans
  ufw_ans="${ufw_ans:-Y}"
  if [[ "${ufw_ans,,}" == "y" || "${ufw_ans,,}" == "yes" ]]; then
    CONFIGURE_UFW="true"
  fi
fi

# ---- Install System Dependencies --------------------------
echo ""
log_info "Updating apt package index and installing prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git openssl nginx certbot python3-certbot-nginx rsync

NODE_OK="false"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if (( NODE_MAJOR >= 18 )); then
    NODE_OK="true"
    log_ok "Node.js $(node -v) already installed."
  fi
fi

if [[ "$NODE_OK" != "true" ]]; then
  log_info "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  log_ok "Installed Node.js $(node -v)."
fi

if ! command -v docker >/dev/null 2>&1; then
  log_info "Installing Docker Engine..."
  if ! curl -fsSL https://get.docker.com | sh; then
    log_warn "Official Docker script failed; falling back to apt docker.io..."
    apt-get install -y docker.io
  fi
fi
systemctl enable --now docker
log_ok "Docker Engine ready."

if ! command -v pm2 >/dev/null 2>&1; then
  log_info "Installing PM2 process manager globally..."
  npm install -g pm2
fi
log_ok "PM2 ready."

JWT_SECRET="$(openssl rand -hex 32)"
WEBHOOK_SECRET="$(openssl rand -hex 32)"
if [[ "$ADMIN_PASS_AUTOGEN" == "true" ]]; then
  ADMIN_PASSWORD="$(openssl rand -base64 14 | tr -dc 'A-Za-z0-9' | head -c 16)"
fi

# ---- Local PostgreSQL Setup (if selected) -----------------
if [[ "$DB_CHOICE" == "1" ]]; then
  if [[ -z "$PG_DB_PASS" ]]; then
    PG_DB_PASS="$(openssl rand -base64 20 | tr -dc 'A-Za-z0-9' | head -c 24)"
  fi

  log_info "Installing & configuring local PostgreSQL..."
  apt-get install -y postgresql postgresql-contrib
  systemctl enable --now postgresql

  for _ in {1..15}; do
    if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  ESC_PASS="${PG_DB_PASS//\'/\'\'}"
  su - postgres -c "psql -v ON_ERROR_STOP=1" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_DB_USER}') THEN
    CREATE ROLE ${PG_DB_USER} WITH LOGIN PASSWORD '${ESC_PASS}';
  ELSE
    ALTER ROLE ${PG_DB_USER} WITH LOGIN PASSWORD '${ESC_PASS}';
  END IF;
END
\$\$;
SQL

  DB_EXISTS="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB_NAME}'\"")"
  if [[ "$DB_EXISTS" != "1" ]]; then
    su - postgres -c "createdb -O '${PG_DB_USER}' '${PG_DB_NAME}'"
  fi

  ENCODED_DB_PASS="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$PG_DB_PASS")"
  DATABASE_URL="postgresql://${PG_DB_USER}:${ENCODED_DB_PASS}@127.0.0.1:5432/${PG_DB_NAME}?sslmode=disable"
  log_ok "Local PostgreSQL database '${PG_DB_NAME}' ready."
fi

# ---- Prepare Project Directory ----------------------------
if [[ "$HAS_LOCAL_REPO" == "true" ]]; then
  if [[ "$INSTALL_DIR" != "$SCRIPT_DIR" ]]; then
    log_info "Syncing project files to ${INSTALL_DIR}..."
    mkdir -p "$INSTALL_DIR"
    rsync -a --exclude node_modules --exclude Frontend/dist --exclude Backend/.env --exclude Frontend/.env "$SCRIPT_DIR/" "$INSTALL_DIR/"
  fi
else
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log_info "Updating existing clone in ${INSTALL_DIR}..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    log_info "Cloning ${REPO_CLONE_URL} into ${INSTALL_DIR}..."
    git clone "$REPO_CLONE_URL" "$INSTALL_DIR"
  fi
fi

# ---- Configure Environment Files --------------------------
SERVER_IP="$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || curl -fsSL --max-time 4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [[ -n "$DASHBOARD_DOMAIN" ]]; then
  SCHEME="http"
  [[ "$INSTALL_SSL" == "true" ]] && SCHEME="https"
  PUBLIC_ORIGIN="${SCHEME}://${DASHBOARD_DOMAIN}"
else
  PUBLIC_ORIGIN="http://${SERVER_IP}"
fi

log_info "Writing ${INSTALL_DIR}/Backend/.env and ${INSTALL_DIR}/Frontend/.env..."
node -e "
const fs = require('fs');
const path = require('path');
const lines = [
  'PORT=' + process.argv[1],
  'DB_DRIVER=' + process.argv[2],
  'DATABASE_URL=' + process.argv[3],
  'JWT_SECRET=' + process.argv[4],
  'ADMIN_USERNAME=' + process.argv[5],
  'ADMIN_PASSWORD=' + process.argv[6],
  'REPOS_PATH=./data/repos',
  'WEBHOOK_SECRET=' + process.argv[7],
  'FRONTEND_URL=' + process.argv[8],
  'BACKEND_PUBLIC_URL=' + process.argv[8],
  'GITHUB_CLIENT_ID=' + process.argv[9],
  'GITHUB_CLIENT_SECRET=' + process.argv[10],
  'CERTBOT_EMAIL=' + process.argv[11],
  'SERVER_PUBLIC_IP=' + process.argv[12],
];
fs.writeFileSync(path.join(process.argv[13], 'Backend', '.env'), lines.join('\n') + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(process.argv[13], 'Frontend', '.env'), 'VITE_API_URL=/api\n', { mode: 0o644 });
" \
  "$APP_PORT" \
  "$DB_DRIVER" \
  "$DATABASE_URL" \
  "$JWT_SECRET" \
  "$ADMIN_USERNAME" \
  "$ADMIN_PASSWORD" \
  "$WEBHOOK_SECRET" \
  "$PUBLIC_ORIGIN" \
  "$GITHUB_CLIENT_ID" \
  "$GITHUB_CLIENT_SECRET" \
  "$CERTBOT_EMAIL" \
  "$SERVER_IP" \
  "$INSTALL_DIR"

chmod 600 "${INSTALL_DIR}/Backend/.env"

# ---- Install Dependencies, Migrate & Set Admin Credentials ----
log_info "Installing Backend dependencies..."
cd "${INSTALL_DIR}/Backend"
npm install --omit=dev

log_info "Running database schema migration..."
npm run db:migrate

log_info "Configuring dashboard admin account '${ADMIN_USERNAME}'..."
node --input-type=module -e "
import './src/config/env.js';
import bcrypt from 'bcryptjs';
import { initDb, getDb, closeDb } from './src/db/database.js';
await initDb();
const sql = getDb();
const username = process.argv[1];
const hash = bcrypt.hashSync(process.argv[2], 12);
const existing = await sql\`SELECT id, token_version FROM users WHERE username = \${username}\`;
if (existing[0]) {
  const nextTv = Number(existing[0].token_version || 1) + 1;
  await sql\`
    UPDATE users
    SET password_hash = \${hash}, role = 'admin', is_active = true, token_version = \${nextTv}
    WHERE id = \${existing[0].id}
  \`;
} else {
  await sql\`
    INSERT INTO users (username, password_hash, role, is_active, token_version)
    VALUES (\${username}, \${hash}, 'admin', true, 1)
  \`;
}
await closeDb();
" "$ADMIN_USERNAME" "$ADMIN_PASSWORD"
log_ok "Database initialized and admin user '${ADMIN_USERNAME}' configured."

log_info "Installing & building Frontend..."
cd "${INSTALL_DIR}/Frontend"
npm install
npm run build

WEB_ROOT="/var/www/paasbydeeep"
mkdir -p "$WEB_ROOT"
rm -rf "${WEB_ROOT:?}"/*
cp -r "${INSTALL_DIR}/Frontend/dist/"* "$WEB_ROOT/"
log_ok "Frontend built and deployed to ${WEB_ROOT}."

# ---- Configure Nginx & Certbot ----------------------------
SERVER_NAME="${DASHBOARD_DOMAIN:-_}"
NGINX_AVAIL="/etc/nginx/sites-available/paasbydeeep"
NGINX_ENAB="/etc/nginx/sites-enabled/paasbydeeep"

cat > "$NGINX_AVAIL" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    root ${WEB_ROOT};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        client_max_body_size 1m;
    }

    access_log /var/log/nginx/paasbydeeep.access.log;
    error_log /var/log/nginx/paasbydeeep.error.log;
}
NGINX

ln -sf "$NGINX_AVAIL" "$NGINX_ENAB"
if [[ -z "$DASHBOARD_DOMAIN" && -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx
log_ok "Nginx configured and reloaded."

SSL_ACTIVE="false"
if [[ -n "$DASHBOARD_DOMAIN" && "$INSTALL_SSL" == "true" ]]; then
  log_info "Obtaining Let's Encrypt SSL certificate for ${DASHBOARD_DOMAIN}..."
  if certbot --nginx -d "$DASHBOARD_DOMAIN" --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --redirect; then
    SSL_ACTIVE="true"
    systemctl reload nginx
    log_ok "SSL certificate installed for ${DASHBOARD_DOMAIN}."
  else
    log_warn "Certbot failed (ensure DNS A record for ${DASHBOARD_DOMAIN} points to ${SERVER_IP} and port 80 is open)."
    log_warn "Retry later with: sudo certbot --nginx -d ${DASHBOARD_DOMAIN}"
  fi
fi

# Persist domain/SSL/public URL in platform_settings
cd "${INSTALL_DIR}/Backend"
node --input-type=module -e "
import './src/config/env.js';
import { initDb, getDb, closeDb } from './src/db/database.js';
await initDb();
const sql = getDb();
await sql\`INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING\`;
await sql\`
  UPDATE platform_settings
  SET public_url = \${process.argv[1]},
      dashboard_domain = \${process.argv[2]},
      dashboard_ssl_enabled = \${process.argv[3] === 'true'},
      certbot_email = \${process.argv[4]},
      updated_at = NOW()
  WHERE id = 1
\`;
await closeDb();
" "$PUBLIC_ORIGIN" "$DASHBOARD_DOMAIN" "$SSL_ACTIVE" "$CERTBOT_EMAIL" || true

# ---- Start Backend with PM2 -------------------------------
mkdir -p /var/log/paasbydeeep
cd "$INSTALL_DIR"
pm2 delete paasbydeeep-backend >/dev/null 2>&1 || true
pm2 start "${INSTALL_DIR}/ecosystem.config.cjs"
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

HEALTH_OK="false"
for _ in {1..15}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK="true"
    break
  fi
  sleep 1
done

# ---- Firewall ---------------------------------------------
if [[ "$CONFIGURE_UFW" == "true" ]]; then
  ufw allow 22/tcp >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  log_ok "UFW rules added for ports 22, 80, 443."
fi

# ---- Final Summary ----------------------------------------
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}          PaaSbyDeep Installation Complete!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo "  Dashboard URL    : ${PUBLIC_ORIGIN}"
echo "  Server Public IP : ${SERVER_IP} (use for custom app DNS A records)"
echo "  Backend Health   : $([[ "$HEALTH_OK" == "true" ]] && echo "OK (port ${APP_PORT})" || echo "Check: pm2 logs paasbydeeep-backend")"
echo "  Database Mode    : $([[ "$DB_CHOICE" == "1" ]] && echo "Local PostgreSQL (${PG_DB_NAME})" || echo "External / Neon DB")"
echo "  Admin Username   : ${ADMIN_USERNAME}"
if [[ "$ADMIN_PASS_AUTOGEN" == "true" ]]; then
  echo "  Admin Password   : ${ADMIN_PASSWORD}  (auto-generated — save this!)"
else
  echo "  Admin Password   : (set by you)"
fi
echo "  Webhook Secret   : ${WEBHOOK_SECRET}"
echo "  Install Path     : ${INSTALL_DIR}"
echo ""
echo "  Useful commands:"
echo "    pm2 status"
echo "    pm2 logs paasbydeeep-backend"
echo "    sudo bash ${INSTALL_DIR}/install.sh --uninstall"
echo -e "${GREEN}============================================================${NC}"
