# YourTinyServer Self-Hosted

A personal LXC management dashboard for running permanent Ubuntu 24.04 instances on your own server.

This edition has no Supabase, customer registration, email verification, payments, balance, invoices, renewals, expiration dates or background billing workers. LXD is the only source of instance state.

For ready-to-use hosted servers, visit [yourtinyserver.com](https://yourtinyserver.com).

## Features

- Five local resource profiles from 512 MB to 8 GB RAM
- Ubuntu 24.04 LTS instances
- Start, restart, freeze, stop and permanently delete instances
- Live CPU, memory, disk, network, process and uptime metrics
- Create, restore and delete snapshots with profile-specific limits
- Interactive root web terminal
- Web-domain routing to an internal port with automatic Let's Encrypt HTTPS
- Live status and private IPv4/IPv6 display
- Docker-ready unprivileged LXC profiles
- HTTPS and administrator authentication through Nginx
- No application database; LXD remains the source of instance state

## Install

### Requirements

- A clean Ubuntu 22.04 or 24.04 KVM VPS or bare-metal server
- A real virtual machine or physical server, not an LXC or OpenVZ container
- Root access
- At least 20 GB of free storage
- A DNS-only A record pointing a domain to the server's public IPv4
- Ports `22`, `80` and `443` available

Example:

```text
lxc.example.com  A  203.0.113.10
```

Connect as root and run:

```bash
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/YourTinyServer/yourtinyserver-selfhosted/main/install.sh \
  -o /tmp/yourtinyserver-selfhosted-install.sh
bash /tmp/yourtinyserver-selfhosted-install.sh
```

The installer asks only for the dashboard domain, administrator username, password setup and TLS email. It can generate a secure administrator password automatically or accept one containing at least 12 characters. Generated passwords are displayed during setup and once more when installation completes.

If validation or a command fails, the installer displays the exact `bash /path/to/install.sh` command needed to retry. It is safe to rerun after correcting the reported problem.

The installer installs LXD and the terminal dependencies, creates the network and profiles, configures Nginx authentication and obtains a Let's Encrypt certificate.

Open the displayed HTTPS URL and sign in with the administrator credentials. Select a profile to create an instance, then use **Manage** to control resources, snapshots, terminal access and web domains. Deleting an instance permanently removes its LXD storage and domain routes.

The first instance can take several minutes because LXD must download and cache the Ubuntu image. Keep the page open until the operation completes. Later instances usually start much faster.

### SSH configuration prompt

Ubuntu may report that `/etc/ssh/sshd_config` was locally modified and ask which version to keep. This commonly happens when a hosting provider has customized SSH access.

Select **keep the local version currently installed**. Replacing it with the package maintainer's version can remove provider-specific settings and prevent a future SSH connection.

After the package operation finishes, validate SSH without closing the current session:

```bash
sshd -t
systemctl is-active ssh
```

Open a second SSH session and confirm that it works before closing the first one.

### Instance creation response error

If an older installation displays `JSON.parse: unexpected character` after creating the first instance, the reverse proxy timed out while LXD was still downloading Ubuntu. Check whether creation continued:

```bash
lxc list --project yourtinyserver-selfhosted
journalctl -u yourtinyserver-selfhosted -n 100 --no-pager
```

Update the checkout and rerun the current installer to apply the longer proxy timeout. The operation is safe to retry; always refresh the instance list before submitting a second creation request.

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

This project is intentionally single-host and single-administrator. It is not a billing platform and does not allocate public IP addresses or public SSH ports. Instances receive private addresses behind LXD NAT. Domain-route metadata is stored locally in `/var/lib/yourtinyserver-selfhosted/domains.json`.

## License

[MIT](LICENSE) - Copyright 2026 KmerHosting LLC.
