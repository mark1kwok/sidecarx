FROM alpine:3.21

RUN apk add --no-cache bash ffmpeg

COPY bin/sidecar /opt/sidecar/sidecar
COPY admin /opt/sidecar/admin
COPY start.sh /opt/sidecar/start.sh

RUN chmod +x /opt/sidecar/sidecar /opt/sidecar/start.sh

ENV SIDECAR_SECRET=demo
ENV SIDECAR_PANEL_DIR=/opt/sidecar/admin

WORKDIR /opt/sidecar
EXPOSE 3000

CMD ["/opt/sidecar/start.sh"]
