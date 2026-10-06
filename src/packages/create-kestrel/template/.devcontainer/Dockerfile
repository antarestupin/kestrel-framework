# Builds the Node.js development container with Git and PostgreSQL administration tools.
# Add operating-system packages here when local development needs them.

FROM node:24-bookworm

# Include database administration tools for the local test-database provisioner.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git postgresql-client \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace/__KESTREL_APPLICATION_NAME__ && chown -R node:node /workspace
