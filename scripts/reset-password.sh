#!/usr/bin/env bash
set -Eeuo pipefail

PASSWORD_FILE="/etc/nginx/.htpasswd-yourtinyserver"
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run this command as root." >&2; exit 1; }
[[ -s "$PASSWORD_FILE" ]] || { echo "Administrator account not found." >&2; exit 1; }

read -r -s -p "New administrator password: " PASSWORD </dev/tty
printf '\n' >/dev/tty
[[ ${#PASSWORD} -ge 12 ]] || { echo "Password must contain at least 12 characters." >&2; exit 1; }
[[ ${#PASSWORD} -le 128 ]] || { echo "Password must contain at most 128 characters." >&2; exit 1; }
[[ "$PASSWORD" =~ [a-z] ]] || { echo "Password must contain a lowercase letter." >&2; exit 1; }
[[ "$PASSWORD" =~ [A-Z] ]] || { echo "Password must contain an uppercase letter." >&2; exit 1; }
[[ "$PASSWORD" =~ [0-9] ]] || { echo "Password must contain a number." >&2; exit 1; }
[[ "$PASSWORD" =~ [^A-Za-z0-9] ]] || { echo "Password must contain a special character." >&2; exit 1; }

USERNAME="$(cut -d: -f1 "$PASSWORD_FILE" | head -n 1)"
printf '%s\n' "$PASSWORD" | htpasswd -iB "$PASSWORD_FILE" "$USERNAME"
systemctl restart yourtinyserver-selfhosted
printf 'Administrator password changed for %s. Existing sessions were closed.\n' "$USERNAME"
