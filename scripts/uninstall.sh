#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="yourtinyserver-selfhosted"
PROJECT="yourtinyserver-selfhosted"
DATA_DIR="/var/lib/yourtinyserver-selfhosted"
APP_DIR="$(systemctl show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run this command as root." >&2; exit 1; }
if [[ "${1:-}" != "--yes" ]]; then
  printf 'This permanently deletes all YourTinyServer instances, snapshots, domain routes and application data.\n'
  read -r -p "Type UNINSTALL to continue: " CONFIRM </dev/tty
  [[ "$CONFIRM" == "UNINSTALL" ]] || { echo "Cancelled."; exit 1; }
fi

mapfile -t CERTIFICATES < <(node -e 'const fs=require("fs");try{for(const route of JSON.parse(fs.readFileSync("/var/lib/yourtinyserver-selfhosted/domains.json","utf8")))if(route.certificateName)console.log(route.certificateName)}catch{}' 2>/dev/null || true)
if [[ -r /etc/yourtinyserver-selfhosted.env ]]; then
  DASHBOARD_DOMAIN="$(sed -n 's#^APP_ORIGIN=https://##p' /etc/yourtinyserver-selfhosted.env | head -n 1)"
  [[ -n "$DASHBOARD_DOMAIN" ]] && CERTIFICATES+=("$DASHBOARD_DOMAIN")
fi

systemctl disable --now "$SERVICE" 2>/dev/null || true
while IFS= read -r INSTANCE; do
  [[ -n "$INSTANCE" ]] && lxc delete "$INSTANCE" --force --project "$PROJECT"
done < <(lxc list --project "$PROJECT" --format csv -c n 2>/dev/null || true)
lxc project delete "$PROJECT" --project default 2>/dev/null || true
lxc network delete ytsbr0 --project default 2>/dev/null || true

for CERTIFICATE in "${CERTIFICATES[@]}"; do
  certbot delete --cert-name "$CERTIFICATE" --non-interactive 2>/dev/null || true
done
find /etc/nginx/sites-enabled /etc/nginx/sites-available -maxdepth 1 -type l -name 'yts-selfhosted-domain-*.conf' -delete 2>/dev/null || true
find /etc/nginx/sites-enabled /etc/nginx/sites-available -maxdepth 1 -type f -name 'yts-selfhosted-domain-*.conf' -delete 2>/dev/null || true
rm -f "/etc/nginx/sites-enabled/$SERVICE" "/etc/nginx/sites-available/$SERVICE"
rm -f "/etc/systemd/system/$SERVICE.service" /etc/yourtinyserver-selfhosted.env /etc/nginx/.htpasswd-yourtinyserver
rm -f /etc/letsencrypt/renewal-hooks/deploy/yourtinyserver-selfhosted-nginx
rm -rf "$DATA_DIR"
if [[ "$APP_DIR" == "/opt/yourtinyserver-selfhosted" ]]; then rm -rf "$APP_DIR"; fi
systemctl daemon-reload
nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
rm -f /usr/local/sbin/yourtinyserver-reset-password /usr/local/sbin/yourtinyserver-uninstall
echo "YourTinyServer Self-Hosted was removed."
