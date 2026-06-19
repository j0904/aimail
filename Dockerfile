# Multi-stage build mirroring ../market/Dockerfile.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Test stage (adds docker-cli for compose-driven e2e) ---
FROM build AS test
RUN apk add --no-cache docker-cli
COPY vitest.config.ts ./
COPY tests ./tests
CMD ["npm", "test"]

# --- Production stage ---
FROM node:22-alpine AS production
ENV NODE_ENV=production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 3080
# Credo's Askar wallet uses native bindings; alpine needs these at runtime.
# (Already satisfied by node:22-alpine's libc + the askar prebuilt binary.)
CMD ["node", "dist/cli/aimail.js", "serve"]
