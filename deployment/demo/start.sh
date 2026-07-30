#!/bin/bash
set -e
export SIDECAR_PORT="3000"
export SIDECAR_HOST="0.0.0.0"
exec /opt/sidecar/sidecar
