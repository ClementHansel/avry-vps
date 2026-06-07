# =============================================================================
# Stage 1: Build backend TypeScript
# =============================================================================
FROM node:20-alpine AS backend-builder

WORKDIR /app

# Install build dependencies for native modules (node-pty, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/

# Exclude frontend from backend compilation (handled by tsconfig exclude)
RUN npm run build

# =============================================================================
# Stage 2: Build Vue 3 frontend with Vite
# =============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Install frontend dependencies
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm ci

# Copy frontend source and build
COPY src/frontend/ ./
RUN npm run build

# =============================================================================
# Stage 3: Production runtime
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies:
# - python3, make, g++, linux-headers: required for node-pty native compilation
# - bash: default shell for terminal sessions
# - curl: health check probe
# - git: build pipeline git clone operations
# - openssh-client: SSH key-based git auth and tunnel operations
# - docker-cli: Docker compose and container management commands
# - nginx: reverse proxy config validation (nginx -t)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    linux-headers \
    bash \
    curl \
    git \
    openssh-client \
    docker-cli \
    nginx

# Install production Node.js dependencies (includes native module compilation)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled backend from build stage
COPY --from=backend-builder /app/dist ./dist

# Copy built frontend from frontend build stage
COPY --from=frontend-builder /app/frontend/dist ./dist/frontend

# Create required directories
RUN mkdir -p /app/data /etc/ssl/vps-panel /app/logs

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV DOCKER_HOST=/var/run/docker.sock
ENV DB_PATH=/app/data/panel.db

EXPOSE 3000

# Health check: verify /health endpoint responds within timeout
# start-period gives the app time to initialize (up to 30s per Requirement 8.4)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

ENTRYPOINT ["node", "dist/server.js"]
