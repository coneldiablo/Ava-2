# Verified OCI index for Keycloak 26.7.3; never follow a mutable latest tag.
FROM quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54 AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --chown=1000:0 themes/ava /opt/keycloak/themes/ava
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
