# --- Stage 1: Builder (Dependencies) ---
# Use slim image for smaller build
FROM python:3.11-slim-bookworm AS builder

ARG PIP_VERSION=26.2
ARG SETUPTOOLS_VERSION=83.0.0
ARG WHEEL_VERSION=0.47.0

WORKDIR /usr/src/app

# Install build dependencies for packages like webrtcvad that need compilation
RUN apt-get -o Acquire::Retries=5 update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Keep packaging tooling free of known, fixed CVEs in both the copied venv and
# the final Python base image.
RUN python -m pip install --no-cache-dir --upgrade \
    "pip==${PIP_VERSION}" \
    "setuptools==${SETUPTOOLS_VERSION}" \
    "wheel==${WHEEL_VERSION}"

# Copy requirements first for optimal caching
COPY requirements.txt .

# Install dependencies (this layer will be cached)
RUN pip install --no-cache-dir -r requirements.txt

# pip is a build-time tool. Do not ship its vendored dependency tree in the
# runtime venv (it is not used by the application and expands attack surface).
RUN python -m pip uninstall --yes pip

# --- Stage 2: Final Runtime Image ---
# Use slim image for smaller footprint
FROM python:3.11-slim-bookworm

ARG PIP_VERSION=26.2
ARG SETUPTOOLS_VERSION=83.0.0
ARG WHEEL_VERSION=0.47.0

# Optimization env vars
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Ensure IANA timezone support when TZ is set via .env (Admin UI → Environment)
RUN apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --upgrade \
    "pip==${PIP_VERSION}" \
    "setuptools==${SETUPTOOLS_VERSION}" \
    "wheel==${WHEEL_VERSION}" \
    && python -m pip uninstall --yes pip

# Note: sox/curl/unzip removed - not needed at runtime
# Audio processing uses Python audioop, downloads done in install.sh

WORKDIR /app

# Create non-root user for security and grant access to asterisk group
# GID defaults to 995 (FreePBX standard) but can be overridden at build time
ARG ASTERISK_GID=995
RUN groupadd -g ${ASTERISK_GID} asterisk || true \
    && useradd --create-home appuser \
    && usermod -aG ${ASTERISK_GID} appuser

# Copy the virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Copy application source code
COPY --chown=appuser:appuser src/ ./src
COPY --chown=appuser:appuser config/ ./config
COPY --chown=appuser:appuser main.py ./

# Prepare log directory for file logging
RUN mkdir -p /app/logs && chown appuser:appuser /app/logs

# Prepare data directory for call history database (Milestone 21)
RUN mkdir -p /app/data && chown appuser:appuser /app/data

# Set PATH for virtual environment
ENV PATH="/opt/venv/bin:$PATH"

# Run the application
USER appuser
CMD ["python", "main.py"]
