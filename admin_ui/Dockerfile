# Stage 1: Build Frontend
FROM node:22-slim AS frontend-builder
WORKDIR /frontend

# Install dependencies first (better Docker caching)
COPY frontend/web/package.json frontend/web/package-lock.json* frontend/web/bun.lock* ./
RUN npm config set fetch-retries 8 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --legacy-peer-deps

# Copy the rest of the frontend source code and build
COPY frontend/web/ ./
RUN npm run build

# Stage 2: Backend and Final Image
FROM python:3.11-slim-bookworm
WORKDIR /app

# Optimization env vars
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    UI_RENDERER_ENABLED=0

# Install Docker CLI and Compose plugin for container management
# This allows admin-ui to start/stop/restart ai-engine and local-ai-server
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    gnupg \
    tzdata \
    gosu \
    python3-dev \
    linux-libc-dev \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (UID 1000) matching ai_engine's appuser
# This fixes SQLite permission issues when both containers write to shared ./data volume
# Docker socket access provided via group_add in docker-compose.yml
RUN useradd --create-home -u 1000 appuser

# Install Python dependencies (bcrypt has manylinux wheels, no gcc needed)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --retries 10 -r requirements.txt

# Copy backend code
COPY backend/ .

# Copy prebuilt frontend assets from the node.js build stage
COPY --from=frontend-builder /frontend/build/client ./static

# Entrypoint: ensure appuser can access the Docker socket regardless of host docker group GID.
COPY entrypoint.sh /app/entrypoint.sh
COPY run-admin-ui.sh /app/run-admin-ui.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh /app/run-admin-ui.sh && \
    chmod +x /app/entrypoint.sh && \
    chmod +x /app/run-admin-ui.sh

# Expose default port (can be overridden by UVICORN_PORT)
EXPOSE 3003

ENTRYPOINT ["/app/entrypoint.sh"]

# Run the application
# NOTE: Binds to 0.0.0.0 by default for remote accessibility (common for Asterisk servers).
# SECURITY: Change admin password on first login and restrict port 3003 via firewall/VPN/reverse proxy.
# Port configurable via UVICORN_PORT env var.
CMD ["/app/run-admin-ui.sh"]
