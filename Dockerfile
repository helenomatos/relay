# One build stage for the whole monorepo, then slim per-service targets.
FROM node:24-alpine AS base
RUN npm install -g pnpm@11.25.0
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/receiver/package.json apps/receiver/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_DEMO_API_KEY
RUN pnpm -r build

# Node services (api, worker, receiver, migrate) — the command picks the service.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node

# Static dashboard behind nginx, which also proxies /api and /receiver.
FROM nginx:1.27-alpine AS dashboard
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
