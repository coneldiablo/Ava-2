# ==========================================
# STAGE 1: Build the React frontend
# ==========================================
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS frontend-builder
WORKDIR /build

# Copy frontend dependency files
COPY frontend/package*.json ./
RUN npm config set fetch-retries 8 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci

# Copy frontend source files
COPY frontend/ ./

# Build the frontend production assets (dist)
RUN npm run build

# ==========================================
# STAGE 2: Install and compile backend dependencies
# ==========================================
FROM node:22.23.2-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS backend-builder
WORKDIR /build

# Copy backend dependency files
COPY package*.json ./

# Install and build dependencies (including native modules)
RUN npm config set fetch-retries 8 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci

# ==========================================
# STAGE 3: Fetch pinned Tesseract language data
# ==========================================
FROM debian:bookworm-slim AS ocr-data

ARG TESSDATA_REF=87416418657359cb625c412a48b6e1d6d41c29bd
ARG TESSDATA_ENG_SHA256=7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2
ARG TESSDATA_RUS_SHA256=e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && install -d /ocr_data \
    && curl --fail --show-error --location --retry 5 \
      "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/eng.traineddata" \
      --output /ocr_data/eng.traineddata \
    && curl --fail --show-error --location --retry 5 \
      "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/rus.traineddata" \
      --output /ocr_data/rus.traineddata \
    && echo "${TESSDATA_ENG_SHA256}  /ocr_data/eng.traineddata" | sha256sum -c - \
    && echo "${TESSDATA_RUS_SHA256}  /ocr_data/rus.traineddata" | sha256sum -c - \
    && rm -rf /var/lib/apt/lists/*

# ==========================================
# STAGE 4: Production runner image
# ==========================================
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runner
WORKDIR /app

# Install system dependencies (ca-certificates)
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Copy backend compiled node_modules
COPY --from=backend-builder /build/node_modules ./node_modules
COPY package*.json ./

# Copy backend source code and tests
COPY src/ ./src
COPY instagram_private/ ./instagram_private/
COPY server.js ./server.js
COPY provisioning-worker.js ./provisioning-worker.js
COPY module-access-server.js ./module-access-server.js
COPY tests/ ./tests

# Copy built frontend assets
COPY --from=frontend-builder /build/dist ./frontend/dist

# Copy verified Tesseract OCR language data from its pinned upstream revision.
COPY --from=ocr-data /ocr_data/ ./ocr_data/

# Install the pinned worker at build time. The connector remains opt-in at runtime.
RUN python3 -m venv /opt/ava-instagram-private \
    && /opt/ava-instagram-private/bin/pip install --no-cache-dir -r ./instagram_private/requirements.txt

# Create a directory for database persistence (to mount a volume)
RUN mkdir -p /app/data

# Define default environment variables (overridden by docker-compose)
ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/app/data/crm_v2.db
ENV TESSERACT_LANG_PATH=/app/ocr_data/
ENV INSTAGRAM_PRIVATE_PYTHON=/opt/ava-instagram-private/bin/python3

EXPOSE 3000

CMD ["node", "server.js"]
