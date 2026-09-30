#!/usr/bin/env bash
# Creates the dedicated test database when the devcontainer starts, preserving existing data.
# Uses DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_TEST_DATABASE from the container environment.

set -euo pipefail

# Use the same connection defaults as the development Docker Compose service.
database_host="${DB_HOST:-postgres}"
database_port="${DB_PORT:-5432}"
database_user="${DB_USER:-postgres}"
database_password="${DB_PASSWORD:-postgres}"
application_test_database="${DB_TEST_DATABASE:-kestrel_playground_test}"

ensure_database() {
  local database_name="$1"

  # Query the PostgreSQL catalog safely by passing the database name as a psql
  # variable. This works for both new and existing development volumes.
  local database_exists
  database_exists="$(
    PGPASSWORD="${database_password}" psql \
      --host="${database_host}" \
      --port="${database_port}" \
      --username="${database_user}" \
      --dbname="postgres" \
      --tuples-only \
      --no-align \
      --set=ON_ERROR_STOP=1 \
      --set=test_database="${database_name}" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'test_database';
SQL
  )"

  if [[ "${database_exists}" == "1" ]]; then
    echo "Test database '${database_name}' already exists."
    return
  fi

  PGPASSWORD="${database_password}" createdb \
    --host="${database_host}" \
    --port="${database_port}" \
    --username="${database_user}" \
    "${database_name}"

  echo "Created test database '${database_name}'."
}

# Application tests own a dedicated database; framework infrastructure lives in its repository.
ensure_database "${application_test_database}"
