#!/bin/bash
set -e

# Cloud platforms (Railway, etc.) inject PORT; default to 3000
export SIDECAR_PORT="${PORT:-3000}"

# Create log directory for supervisord
mkdir -p /var/log/supervisor

# Start supervisord as PID 1 - it manages all processes
exec /usr/bin/supervisord -c /opt/sidecar/supervisord.conf
