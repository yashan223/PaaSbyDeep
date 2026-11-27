# PaaSbyDeep

A lightweight, self-hosted DevOps platform to deploy and manage GitHub apps on a single VPS using Docker, Nginx, and Certbot.

## Stack

- **Frontend:** React 19 + Vite
- **Backend:** Node.js + Express + WebSockets (`/api/ws`)
- **Database:** PostgreSQL — supports **Neon DB** (`@neondatabase/serverless`) and **standard PostgreSQL** (`pg`)
- **Deployment:** Docker (`dockerode`), `simple-git`, Nginx, Certbot

## Features

- GitHub account connection (Personal Access Token or OAuth), searchable repo picker, and auto-created push webhooks
- Auto-detection & fallback Dockerfiles for Next.js, Vite/SPA, Node.js, Python (FastAPI/Django/Flask), Go, and static HTML
- Single-concurrency deployment queue with live log streaming and `:previous` rollback tagging
- Custom domain routing with Nginx vhost generation and Certbot Let's Encrypt SSL installer
- Dashboard management settings (container RAM limit, history retention, admin credentials, Docker image pruning)

## Quick VPS Install (Ubuntu / Debian)

Run the interactive auto-installer as `root` on Ubuntu (20.04/22.04/24.04) or Debian (11/12):

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yashan223/PaaSbyDeep/master/install.sh)
```

> If logged in as a non-root `sudo` user, download and run it with `sudo`:
> `curl -Ls https://raw.githubusercontent.com/yashan223/PaaSbyDeep/master/install.sh -o install.sh && sudo bash install.sh`

The installer prompts for your preferences and sets up:
- Node.js 20, Docker Engine, Nginx, Certbot, and PM2
- Choice of **local PostgreSQL** (auto-installed & configured) or an **existing Neon DB / external PostgreSQL URL**
- Admin username & password (persisted directly into the database), generated secrets, schema migration, Frontend production build, Nginx reverse proxy, optional Let's Encrypt SSL, and PM2 systemd startup

To completely uninstall PaaSbyDeep (PM2 service, `paasbydeeep-*` Docker containers/images, Nginx configs, Certbot certs, database/tables, and app files):

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yashan223/PaaSbyDeep/master/install.sh) --uninstall
```

Or run directly from your install directory (default `/opt/paasbydeeep`):

```bash
sudo bash /opt/paasbydeeep/install.sh --uninstall
```

## CLI Management

The installer installs the `paasbydeeep` CLI globally (`/usr/local/bin/paasbydeeep`):

```bash
sudo paasbydeeep update        # Pull latest code, migrate DB, rebuild UI & restart backend
paasbydeeep status             # Service, health check, Nginx, DB & container overview
paasbydeeep logs               # Follow PM2 backend logs
paasbydeeep restart            # Restart backend service
paasbydeeep doctor             # Check Node, Docker, Nginx, ports & DB connectivity
sudo paasbydeeep reset-admin   # Reset or create an admin user in DB
sudo paasbydeeep uninstall     # Remove PaaSbyDeep from the VPS
```

## Local Development Setup

### Prerequisites
- Node.js >= 18
- Docker Engine / Docker Desktop
- Git and a PostgreSQL or [Neon](https://console.neon.tech/) database URL

### 1. Clone the repository
```bash
git clone https://github.com/yashan223/PaaSbyDeep.git
cd PaaSbyDeep
```

### 2. Install dependencies
```bash
npm run install:all
```

### 3. Configure environment variables
```bash
cp Backend/.env.example Backend/.env
cp Frontend/.env.example Frontend/.env
```

Minimum required in `Backend/.env`:
```env
PORT=3001
DB_DRIVER=auto
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/paasbydeeep?sslmode=disable
JWT_SECRET=your_random_32_plus_char_secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
WEBHOOK_SECRET=your_webhook_secret
FRONTEND_URL=http://localhost:5173
```

`Frontend/.env`:
```env
VITE_API_URL=http://localhost:3001/api
```

### 4. Run
```bash
# Terminal 1 — Backend (initializes PostgreSQL / Neon schema automatically)
npm run backend

# Terminal 2 — Frontend
npm run frontend
```
Open `http://localhost:5173`. Run `cd Backend && npm run db:migrate` to inspect/apply migrations manually.

## Environment Reference

| Variable | File | Default | Description |
|---|---|---|---|
| `DB_DRIVER` | `Backend/.env` | `auto` | `auto` (Neon HTTP for `*.neon.tech`, `pg` for all other PostgreSQL hosts), `pg`, or `neon` |
| `DATABASE_URL` | `Backend/.env` | — | PostgreSQL or Neon DB connection string |
| `JWT_SECRET` | `Backend/.env` | — | Secret for JWT signing & token encryption |
| `ADMIN_USERNAME` | `Backend/.env` | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | `Backend/.env` | — | Initial admin password |
| `WEBHOOK_SECRET` | `Backend/.env` | — | HMAC secret for GitHub webhooks |
| `FRONTEND_URL` | `Backend/.env` | `http://localhost:5173` | Allowed CORS origin |
| `BACKEND_PUBLIC_URL` | `Backend/.env` | `http://localhost:3001` | Optional public URL for OAuth & webhooks |
| `GITHUB_CLIENT_ID` / `SECRET` | `Backend/.env` | — | Optional GitHub OAuth app credentials |
| `CERTBOT_EMAIL` | `Backend/.env` | — | Optional default email for Certbot SSL |
| `VITE_API_URL` | `Frontend/.env` | `http://localhost:3001/api` | Backend API base URL (or `/api` behind Nginx) |
