#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${YTS_APP_DIR:-/opt/yourtinyserver-selfhosted}"
REPOSITORY="${YTS_REPOSITORY:-https://github.com/YourTinyServer/yourtinyserver-selfhosted.git}"
PROJECT="yourtinyserver-selfhosted"
NETWORK="ytsbr0"
SERVICE="yourtinyserver-selfhosted"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

read_value() {
  local prompt="$1" variable="$2" value
  read -r -p "$prompt: " value </dev/tty
  printf -v "$variable" '%s' "$value"
}

read_secret() {
  local prompt="$1" variable="$2" value
  read -r -s -p "$prompt: " value </dev/tty
  printf '\n' >/dev/tty
  printf -v "$variable" '%s' "$value"
}

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]
}

public_ipv4() {
  curl -4fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}'
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Run this installer as root."
source /etc/os-release
[[ "$ID" == "ubuntu" && ( "$VERSION_ID" == "22.04" || "$VERSION_ID" == "24.04" ) ]] || die "Ubuntu 22.04 or 24.04 is required."

SERVER_IPV4="$(public_ipv4)"
printf '\nCreate a DNS-only A record pointing your dashboard domain to %s before continuing.\n\n' "$SERVER_IPV4"
read_value "Dashboard domain (without https://)" APP_DOMAIN
read_value "Administrator username" ADMIN_USER
read_secret "Administrator password" ADMIN_PASSWORD
read_value "Email for the TLS certificate" TLS_EMAIL

valid_domain "$APP_DOMAIN" || die "Invalid dashboard domain."
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]{3,32}$ ]] || die "Administrator username must contain 3-32 letters, numbers, dots, hyphens or underscores."
[[ ${#ADMIN_PASSWORD} -ge 12 ]] || die "Administrator password must contain at least 12 characters. Run 'bash $0' to retry."
[[ "$TLS_EMAIL" == *@*.* ]] || die "Invalid TLS email."

RESOLVED="$(getent ahostsv4 "$APP_DOMAIN" | awk 'NR==1 {print $1}')"
[[ "$RESOLVED" == "$SERVER_IPV4" ]] || die "$APP_DOMAIN resolves to ${RESOLVED:-nothing}, not $SERVER_IPV4."

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y apache2-utils ca-certificates certbot curl git nginx python3-certbot-nginx snapd ufw

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
  bash /tmp/nodesource-setup.sh
  apt-get install -y nodejs
fi

log "Installing LXD"
if ! snap list lxd >/dev/null 2>&1; then
  snap install lxd --channel=5.21/stable
fi
snap wait system seed.loaded >/dev/null 2>&1 || true

if ! lxc storage show default >/dev/null 2>&1; then
  lxd init --preseed <<'YAML'
config: {}
networks: []
storage_pools:
- name: default
  driver: dir
profiles:
- name: default
  devices:
    root:
      path: /
      pool: default
      type: disk
YAML
fi

if ! lxc project show "$PROJECT" --project default >/dev/null 2>&1; then
  lxc project create "$PROJECT" --project default \
    -c features.images=true \
    -c features.profiles=true \
    -c features.storage.volumes=true \
    -c features.networks=true
fi

if ! lxc network show "$NETWORK" --project "$PROJECT" >/dev/null 2>&1; then
  lxc network create "$NETWORK" --project "$PROJECT" \
    ipv4.address=10.242.0.1/24 ipv4.nat=true ipv6.address=auto ipv6.nat=true
fi

create_profile() {
  local name="$1" cpu="$2" memory="$3" disk="$4"
  lxc profile show "$name" --project "$PROJECT" >/dev/null 2>&1 || lxc profile create "$name" --project "$PROJECT"
  lxc profile set "$name" \
    limits.cpu="$cpu" limits.memory="$memory" \
    security.nesting=true \
    security.syscalls.intercept.mknod=true \
    security.syscalls.intercept.setxattr=true \
    --project "$PROJECT"
  lxc profile device remove "$name" eth0 --project "$PROJECT" >/dev/null 2>&1 || true
  lxc profile device add "$name" eth0 nic network="$NETWORK" name=eth0 --project "$PROJECT"
  lxc profile device remove "$name" root --project "$PROJECT" >/dev/null 2>&1 || true
  lxc profile device add "$name" root disk pool=default path=/ size="$disk" --project "$PROJECT"
}

create_profile "Tiny 512" 1 512MiB 10GiB
create_profile "Tiny 1G" 1 1GiB 20GiB
create_profile "Tiny 2G" 1 2GiB 30GiB
create_profile "Tiny 4G" 2 4GiB 50GiB
create_profile "Tiny 8G" 4 8GiB 100GiB

log "Installing the dashboard"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
elif [[ -e "$APP_DIR" ]]; then
  die "$APP_DIR already exists and is not a Git checkout."
else
  git clone --depth 1 "$REPOSITORY" "$APP_DIR"
fi

cat > /etc/yourtinyserver-selfhosted.env <<EOF
HOST=127.0.0.1
PORT=3060
APP_ORIGIN=https://$APP_DOMAIN
LXD_PROJECT=$PROJECT
EOF
chmod 600 /etc/yourtinyserver-selfhosted.env

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=YourTinyServer Self-Hosted
After=network-online.target snap.lxd.daemon.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/yourtinyserver-selfhosted.env
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

printf '%s\n' "$ADMIN_PASSWORD" | htpasswd -iBc /etc/nginx/.htpasswd-yourtinyserver "$ADMIN_USER"
chown root:www-data /etc/nginx/.htpasswd-yourtinyserver
chmod 640 /etc/nginx/.htpasswd-yourtinyserver

cat > /etc/nginx/sites-available/$SERVICE <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $APP_DOMAIN;

  location ^~ /.well-known/acme-challenge/ {
    auth_basic off;
    root /var/www/html;
  }

  location / {
    auth_basic "YourTinyServer Self-Hosted";
    auth_basic_user_file /etc/nginx/.htpasswd-yourtinyserver;
    proxy_pass http://127.0.0.1:3060;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF

ln -sfn /etc/nginx/sites-available/$SERVICE /etc/nginx/sites-enabled/$SERVICE
nginx -t
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl reload nginx

log "Configuring firewall and HTTPS"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
certbot --nginx -d "$APP_DOMAIN" --non-interactive --agree-tos --email "$TLS_EMAIL" --redirect

curl -fsS -u "$ADMIN_USER:$ADMIN_PASSWORD" "https://$APP_DOMAIN/api/overview" >/dev/null || die "Dashboard health check failed."

printf '\n\033[1;32mYourTinyServer Self-Hosted is ready.\033[0m\n'
printf 'Dashboard: https://%s\n' "$APP_DOMAIN"
printf 'Username:  %s\n' "$ADMIN_USER"
printf '\nThe dashboard stores no customer, payment or billing data. LXD is the source of truth.\n'
