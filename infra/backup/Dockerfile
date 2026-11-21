# Service `backup` de Tournéo : pg_dump quotidien chiffré, rétention, copie hors serveur (rclone).
# Client PostgreSQL de même version majeure que le serveur (16).
FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg rclone ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY common.sh backup.sh restore.sh entrypoint.sh healthcheck.sh /opt/backup/
RUN chmod 755 /opt/backup/*.sh \
    && ln -s /opt/backup/backup.sh /usr/local/bin/backup \
    && ln -s /opt/backup/restore.sh /usr/local/bin/restore \
    && mkdir -p /backups

ENV BACKUP_DIR=/backups \
    TZ=Africa/Douala

VOLUME ["/backups"]
HEALTHCHECK --interval=5m --timeout=10s --start-period=15m --retries=1 CMD ["/opt/backup/healthcheck.sh"]

# Remplace l'ENTRYPOINT de l'image postgres (qui démarrerait un serveur).
ENTRYPOINT ["/opt/backup/entrypoint.sh"]
