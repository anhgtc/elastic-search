# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Cài dependencies (tận dụng cache layer)
COPY package.json package-lock.json* ./
RUN npm ci

# Build TypeScript -> dist/
COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY elasticsearch ./elasticsearch
COPY web ./web
RUN npm run build

# Gỡ devDependencies để image runtime gọn
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chạy bằng user không phải root
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/elasticsearch ./elasticsearch
COPY --from=builder /app/web ./web
COPY package.json ./

USER app

# APP_MODE quyết định vai trò container: api | worker | reindex
ENV APP_MODE=api
EXPOSE 3000
CMD ["node", "dist/main.js"]
