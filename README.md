# YourTinyServer Self-Hosted

A free, single-administrator LXD dashboard for your own Ubuntu server. It has no accounts, payments, billing, renewals or external database.

Use paid version if you don't have your own Server or if you want to deploy an instance faster: [yourtinyserver.com](https://yourtinyserver.com).

## Included

- Five resource profiles from 512 MB to 8 GB RAM
- The same 41 Linux images offered by YourTinyServer
- Start, restart, freeze, stop and delete controls
- Unlimited local snapshots with restore
- CPU, memory, disk, network and uptime metrics
- Interactive root web terminal
- Automatic Nginx and Let's Encrypt domain routing
- OS reinstallation from the complete image catalog
- Docker-ready unprivileged LXC profiles

## Requirements

- Clean Ubuntu (22.04 LTS or newer but 24.04 LTS is recommended) only KVPS or bare-metal server
- KVM Virtualization
- Root access and at least 20 GB free storage
- DNS-only A record pointing the dashboard domain to the server IPv4
- Ports `22`, `80` and `443` available

Do not install it inside an LXC or OpenVZ container.

## Install

```bash
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/YourTinyServer/yourtinyserver-selfhosted/main/install.sh \
  -o /tmp/yourtinyserver-selfhosted-install.sh
bash /tmp/yourtinyserver-selfhosted-install.sh
```

The installer configures LXD, profiles, networking, Nginx, administrator authentication and HTTPS. It can generate the administrator password. If setup fails, correct the reported problem and rerun the displayed retry command.

If Ubuntu asks what to do with a modified `/etc/ssh/sshd_config`, select **keep the local version currently installed**. Confirm SSH from a second session before closing the first one.

## Operations

```bash
systemctl status yourtinyserver-selfhosted
journalctl -u yourtinyserver-selfhosted -f
lxc list --project yourtinyserver-selfhosted
```

Update:

```bash
cd /opt/yourtinyserver-selfhosted
git pull --ff-only
npm ci --omit=dev
systemctl restart yourtinyserver-selfhosted
```

Reset the administrator password:

```bash
yourtinyserver-reset-password
```

Uninstall the platform and permanently delete its instances and data:

```bash
yourtinyserver-uninstall
```

Instances use private LXD NAT addresses. Domain routes are stored locally in `/var/lib/yourtinyserver-selfhosted/domains.json`.
Use port `80` while an installer completes HTTP-01 validation. If it creates its own HTTPS listener, use **Edit routing** and change the port to `443`; the platform automatically uses HTTPS internally for port `443`. Host ACME files remain authoritative, while unmatched challenges are forwarded to port `80` inside the instance.

## License

[MIT](LICENSE) - Copyright 2026 KmerHosting LLC.
