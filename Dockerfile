FROM node:20-alpine

# Install pnpm — matches packageManager field in package.json
RUN npm install -g pnpm@10.30.3

WORKDIR /app

# Copy manifests first so dependency installation is cached separately
# from source changes (cache-busted only when package.json / lockfile changes)
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# tsconfig.json is required at runtime — tsx uses it for module resolution
COPY tsconfig.json ./

# Application source
COPY src/ ./src/

# Run as non-root
RUN addgroup -S bot && adduser -S bot -G bot && chown -R bot:bot /app
USER bot

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check — gives 30s for startup (Redis ping, webhook registration)
# then probes every 30s. Uses wget because curl isn't in alpine by default.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["pnpm", "start"]
