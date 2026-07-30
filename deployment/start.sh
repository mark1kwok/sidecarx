#!/bin/bash
set -e

# Railway injects PORT
export SIDECAR_PORT="${PORT:-3000}"

# Persist entire /root state on Railway volume
mkdir -p /data/root
mkdir -p /data/backups

if [ ! -L /root ]; then
    # 1. Backup the living-before-redeployment /data/root (if it has data)
    # Using tar to conserve disk space and inodes on the volume across many redeploys
    if [ "$(ls -A /data/root 2>/dev/null)" ]; then
        tar -czf "/data/backups/root_backup_$(date +%Y%m%d_%H%M%S).tar.gz" -C /data root
    fi

    # 2. Merge fresh container /root into volume, but don't overwrite existing user data
    rsync -a --ignore-existing /root/ /data/root/

    # 3. Delete the fresh image /root entirely out of the way
    rm -rf /root

    # 4. Symlink operational /root to point to the persistent data volume
    ln -s /data/root /root
fi

# Create log directory for supervisord
mkdir -p /var/log/supervisor

# 5. Initialize or update persistent directory if missing
# This allows hot-swapping binaries! If users place a new 'sidecar' binary in /root/.sidecar,
# it won't be overwritten, allowing easy upgrades without redeploying the Docker image.
mkdir -p /root/.sidecar
if [ ! -f /root/.sidecar/sidecar ] || [ ! -f /root/.sidecar/supervisord.conf ]; then
    echo "Seeding /root/.sidecar with default files..."
    cp --update=none -r /opt/sidecar_seed/sidecar/* /root/.sidecar/ || true
    cp --update=none /opt/sidecar_seed/supervisord.conf /root/.sidecar/supervisord.conf || true
    chmod +x /root/.sidecar/sidecar
fi

# Start supervisord as PID 1 — it manages all processes
exec /usr/bin/supervisord -c /root/.sidecar/supervisord.conf
