FROM ubuntu:26.04

# Install supervisor for managing multiple processes via supervisorctl (the container-friendly alternative to systemctl)
# systemd/systemctl cannot easily run inside standard Docker containers because it requires PID 1 and system-level privileges.
# Optional: ffmpeg enables video thumbnail generation (/fs/thumbnail).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git \
        vim nano htop curl wget jq tree unzip zip openssh-client rsync \
        # Process supervisor
        supervisor \
        # Optional: ffmpeg enables video thumbnail generation (/fs/thumbnail)
        # ffmpeg \
        # xvfb: only needed if running GUI apps headless; uncomment if required
        # xvfb \
        && rm -rf /var/lib/apt/lists/*

# Ensure interactive bash in container uses colored prompt
ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV FORCE_COLOR=3
RUN echo "export PS1='\[\e[32m\]\u@\h:\[\e[34m\]\w\[\e[32m\]\$ \[\e[0m\]'" >> /root/.bashrc

# Copy sidecar (binary + admin panel) + supervisord config + entrypoint
# Place your built sidecar binary and admin/ directory into sidecar/ before building
COPY sidecar/ /opt/sidecar/
COPY supervisord.conf /opt/sidecar/supervisord.conf
COPY start.sh /opt/sidecar/start.sh

RUN chmod +x /opt/sidecar/start.sh /opt/sidecar/sidecar

WORKDIR /root

CMD ["/opt/sidecar/start.sh"]
