FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d
# TLS listens on 8443. Drop the image's file capability so exec works with cap_drop: ALL.
RUN setcap -r /usr/bin/caddy
