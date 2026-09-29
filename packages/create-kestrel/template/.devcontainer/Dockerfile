FROM node:24-bookworm

# Include database administration tools for the local test-database provisioner.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git postgresql-client \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace/app && chown -R node:node /workspace
