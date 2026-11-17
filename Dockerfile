# node:22-alpine, pinned by digest (multi-arch index, read 2026-11-17). Update the digest to take base-image fixes.
ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# Build stage: compile TypeScript, then drop dev dependencies.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
# --ignore-scripts: the `prepare` build runs below, once the sources are copied in.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime stage: no compiler, no dev dependencies, runs as the unprivileged node user.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prices.json LICENSE NOTICE ./
USER node
EXPOSE 8080
# On SIGTERM the guard hangs up live calls within SHUTDOWN_GRACE_SECONDS (default 25).
# Give it longer than that to stop: `docker stop -t 30`, or Kubernetes' default 30 s grace period.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/health" > /dev/null || exit 1
CMD ["node", "dist/main.js"]
