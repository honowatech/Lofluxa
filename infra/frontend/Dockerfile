# Image du front-end Tournéo : build Vite du dossier frontend/ → fichiers statiques servis par Caddy.
# Contexte de construction : le dossier frontend/ (créé par le lot L9).
#
# L'image finale ne contient que le résultat du build. À chaque démarrage, le conteneur recopie ce
# résultat dans le volume partagé avec Caddy (/srv/www), puis s'arrête : c'est Caddy qui sert les fichiers.

FROM node:22-alpine AS build

WORKDIR /app

# Dépendances d'abord (couche mise en cache tant que les fichiers de verrouillage ne changent pas).
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

COPY . .

# L'interface appelle l'API sur la même origine, derrière Caddy.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build && test -f dist/index.html

FROM busybox:1.36 AS publish

COPY --from=build /app/dist /dist

# Publication : le contenu du volume est remplacé par le build embarqué dans l'image.
CMD ["sh", "-c", "mkdir -p /srv/www && rm -rf /srv/www/* /srv/www/.[!.]* && cp -a /dist/. /srv/www/ && echo \"Interface publiée dans /srv/www ($(find /srv/www -type f | wc -l) fichiers).\""]
