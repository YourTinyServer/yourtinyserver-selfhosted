# YourTinyServer Self-Hosted

A small personal dashboard for creating permanent Ubuntu 24.04 LXC instances on your own server.

This edition has no Supabase, customer registration, email verification, payments, balance, invoices, renewals, expiration dates or background billing workers. LXD is the only source of instance state.

For ready-to-use hosted servers, visit [yourtinyserver.com](https://yourtinyserver.com).

## Features

- Five local resource profiles from 512 MB to 8 GB RAM
- Ubuntu 24.04 LTS instances
- Create and permanently delete instances
- Live status and private IPv4 display
- Docker-ready unprivileged LXC profiles
- HTTPS and administrator authentication through Nginx
- No application database and no npm dependencies

## Install

### Requirements

- A clean Ubuntu 22.04 or 24.04 VPS using KVM virtualization
- A real virtual machine, not an LXC or OpenVZ container
- Root access
- At least 20 GB of free storage
- A DNS-only A record pointing a domain to the VPS public IPv4
- Ports `22`, `80` and `443` available

Example:

```text
lxc.example.com  A  203.0.113.10
```

Connect as root and run:

```bash
apt update && apt install -y curl && apt upgrade -y
curl -fsSL https://raw.githubusercontent.com/YourTinyServer/yourtinyserver-selfhosted/main/install.sh \
  -o /tmp/yourtinyserver-selfhosted-install.sh
bash /tmp/yourtinyserver-selfhosted-install.sh
```

The installer asks only for the dashboard domain, administrator username, administrator password and TLS email. It installs LXD, creates the network and profiles, configures Nginx authentication and obtains a Let's Encrypt certificate.

Open the displayed HTTPS URL and sign in with the administrator credentials. Select a profile to create an instance. Deleting an instance permanently removes its LXD storage.

## Operations

```bash
systemctl status yourtinyserver-selfhosted
journalctl -u yourtinyserver-selfhosted -f
lxc list --project yourtinyserver-selfhosted
nginx -t
```

Open a shell in an instance from the host:

```bash
lxc exec INSTANCE_NAME --project yourtinyserver-selfhosted -- bash
```

Update the application:

```bash
cd /opt/yourtinyserver-selfhosted
git pull --ff-only
systemctl restart yourtinyserver-selfhosted
```

## Scope

This project is intentionally single-host and single-administrator. It is not a billing platform and does not allocate public IP addresses or public SSH ports. Instances receive private addresses behind LXD NAT.

## License

[MIT](LICENSE) - Copyright 2026 KmerHosting LLC.
