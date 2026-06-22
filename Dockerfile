# Multi-stage build mirroring ../market/Dockerfile.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Test stage (adds docker-cli for compose-driven e2e) ---
FROM build AS test
COPY vitest.config.ts ./
COPY tests ./tests
CMD ["npm", "test"]

# --- Production stage ---
FROM node:22 AS production
ENV NODE_ENV=production
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 3080
CMD ["node", "dist/cli/aimail.js", "serve"]
