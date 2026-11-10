import { installPostgresDestinationGuard } from "./postgres-destination-guard.mjs";
import { installRedisNamespaceGuard } from "./redis-namespace-guard.mjs";

// The guard lives outside the mutation scope and runs before framework test imports.
installPostgresDestinationGuard();
installRedisNamespaceGuard();
