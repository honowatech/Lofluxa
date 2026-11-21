# Images OSRM de Tournéo (deux cibles) :
#   download : télécharge l'extrait OpenStreetMap du Cameroun (Geofabrik) dans le volume de données ;
#   osrm     : prétraitement avec le profil camion (osrm-extract / osrm-partition / osrm-customize,
#              ou osrm-contract) puis service osrm-routed.
# L'image officielle d'OSRM ne contient ni curl ni wget : le téléchargement se fait donc à part.

FROM alpine:3.20 AS download
RUN apk add --no-cache curl ca-certificates
COPY download.sh /usr/local/bin/download.sh
RUN chmod 755 /usr/local/bin/download.sh
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/download.sh"]

FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS osrm
# Le profil camion s'appuie sur car.lua et lib/, fournis par l'image dans /opt.
COPY truck.lua /opt/truck.lua
COPY prepare.sh entrypoint.sh healthcheck.sh /opt/tourneo/
RUN chmod 755 /opt/tourneo/*.sh \
    && test -f /opt/car.lua && test -d /opt/lib \
    && mkdir -p /data
VOLUME ["/data"]
EXPOSE 5000
# Premier démarrage : le prétraitement du Cameroun prend plusieurs minutes avant qu'OSRM ne réponde.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45m --retries=3 CMD ["/opt/tourneo/healthcheck.sh"]
ENTRYPOINT ["/opt/tourneo/entrypoint.sh"]
CMD ["serve"]
