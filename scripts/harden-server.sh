#!/bin/sh
# Hardens a fresh Ubuntu VPS for the Office CRM (plan section 10). Run once as root. Safe to re-run.
#  - firewall: only SSH, 80 and 443 are open (the database and the CRM app have no public ports at all)
#  - automatic security updates
#  - SSH: key login only, no root password login
#  - brute-force protection for SSH (fail2ban)
# Before running: make sure your SSH key login works, or you will lock yourself out.
set -eu
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw unattended-upgrades fail2ban

# Firewall. Docker publishes only Caddy (80/443); see docker-compose.yml.
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp        # SSH, rate limited. Tighten with: ufw allow from <your-ip> to any port 22
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Automatic security updates (reboots are NOT automatic: do them in a quiet hour)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
systemctl enable --now unattended-upgrades

# SSH: keys only
install -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-office-crm.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin prohibit-password
CONF
systemctl reload ssh || systemctl reload sshd

systemctl enable --now fail2ban

echo "Done. Open ports:"; ufw status | sed -n 1,12p
