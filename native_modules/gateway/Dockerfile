FROM node:22.23.2-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY --from=dependencies /build/node_modules ./node_modules
COPY *.cjs package.json ./
RUN mkdir -p /var/lib/ava-gateway && chown node:node /var/lib/ava-gateway
USER node
EXPOSE 4080
CMD ["node", "main.cjs"]
