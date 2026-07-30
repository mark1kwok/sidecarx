FROM ubuntu:26.04

# Install supervisor for managing multiple processes via supervisorctl (the container-friendly alternative to systemctl)
# systemd/systemctl cannot easily run inside standard Docker containers because it requires PID 1 and system-level privileges.
# Optional: ffmpeg enables video thumbnail generation (/fs/thumbnail).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git \
        vim nano htop curl wget jq tree unzip zip openssh-client rsync \
        xvfb \
        # Process supervisor
        supervisor \
        ffmpeg && \
        rm -rf /var/lib/apt/lists/*

# Create seed directory for persistent binaries/configs
WORKDIR /opt/sidecar_seed

# Ensure interactive bash in container uses colored prompt (saved for start.sh to migrate to volume)
ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV FORCE_COLOR=3
RUN echo "export PS1='\[\e[32m\]\u@\h:\[\e[34m\]\w\[\e[32m\]\$ \[\e[0m\]'" >> /root/.bashrc
RUN cp /root/.bashrc /opt/sidecar_seed/.bashrc

# Copy sidecar (binary, admin panel, configs) + entrypoint + supervisord config
COPY release/ ./sidecar/
COPY supervisord.conf ./supervisord.conf
COPY start.sh ./start.sh

RUN chmod +x ./start.sh ./sidecar/sidecar

# Persistent user data (mount a Railway volume here)
RUN mkdir -p /data
WORKDIR /root

CMD ["/opt/sidecar_seed/start.sh"]
