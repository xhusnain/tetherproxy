# ---- Build stage ----
FROM node:lts-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:lts-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Persisted store + generated TLS cert live on mounted volumes.
RUN mkdir -p /data /certs
VOLUME ["/data", "/certs"]
ENV DATA_DIR=/data CERT_DIR=/certs
EXPOSE 8080 8081 8443
CMD ["node", "dist/index.js"]
