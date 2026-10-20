# BimGuesser – Container-Image (gebaut von GitHub Actions bei jedem Tag v*)

# ---- Build: Typecheck + Client bauen
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

# ---- Laufzeit: nur Server, Netzdaten und fertiger Client
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATE_DIR=/app/state \
    TRUST_PROXY="loopback, uniquelocal"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY data/network.json data/headways.json ./data/
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/state && chown node:node /app/state
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
VOLUME ["/app/state"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.ts"]
