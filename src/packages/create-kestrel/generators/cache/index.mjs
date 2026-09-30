import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";
import { replaceSource, updateInfrastructure } from "../files.mjs";

/** Compose one cache backend; PostgreSQL remains the application's database in either case. */
export default class CacheGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    const redis = this.options.cache === "redis";
    const templates = fileURLToPath(new URL("./templates/", import.meta.url));
    this.fs.copyTpl(`${templates}/cache.ts.ejs`, this.destinationPath("src/server/core/config/cache.ts"), this.options);
    replaceSource(this, "src/server/core/appConfig.ts", 'import { createLoggerConfig } from "./config/logger.js";',
      'import { createLoggerConfig } from "./config/logger.js";\nimport { createCacheConfig } from "./config/cache.js";'
      + (redis ? '\nimport { createRedisConfig } from "./config/redis.js";' : ""));
    replaceSource(this, "src/server/core/appConfig.ts", "  logger: createLoggerConfig(configurationApi),",
      "  logger: createLoggerConfig(configurationApi),\n  cache: createCacheConfig(),"
      + (redis ? "\n  redis: createRedisConfig(configurationApi)," : ""));
    replaceSource(this, "src/server/core/app.ts", 'import { DatabaseProvider } from "./providers/database_provider.js";',
      'import { DatabaseProvider } from "./providers/database_provider.js";\n'
      + (redis ? 'import { RedisCacheProvider } from "./providers/redis_cache_provider.js";' : 'import { CacheProvider } from "@kestrel/framework/cache";'));
    replaceSource(this, "src/server/core/app.ts", "  .register(new DatabaseProvider(app.config.database, environment))",
      "  .register(new DatabaseProvider(app.config.database, environment))\n"
      + (redis ? "  .register(new RedisCacheProvider(app.config.cache, app.config.redis))" : "  .register(new CacheProvider(app.config.cache))"));

    if (redis) {
      this.fs.copy(`${templates}/redis.ts`, this.destinationPath("src/server/core/config/redis.ts"));
      this.fs.copy(`${templates}/redis_cache_provider.ts`, this.destinationPath("src/server/core/providers/redis_cache_provider.ts"));
      this.fs.copy(`${templates}/redis_cache_provider.test.ts.ejs`, this.destinationPath("src/server/core/providers/redis_cache_provider.test.ts"));
      const manifestPath = this.destinationPath("package.json");
      const manifest = this.fs.readJSON(manifestPath);
      manifest.dependencies["@redis/client"] = "^6.2.1";
      this.fs.writeJSON(manifestPath, manifest);
      this.fs.append(this.destinationPath(".env.example"), "\n# Redis cache connection; test runs use database 2 when no override is supplied.\nREDIS_URL=redis://127.0.0.1:56379/0\n");
      updateInfrastructure(this, (document) => {
        // Never remove Redis contributed by another feature; its first owner installs the service.
        if (!document.hasIn(["services", "redis"])) document.setIn(["services", "redis"], {
          image: "redis:8-alpine", ports: ["127.0.0.1:56379:6379"],
          command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"],
          tmpfs: ["/data"],
          healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: "5s", timeout: "3s", retries: 10 },
        });
        document.setIn(["services", "app", "environment", "REDIS_URL"], "redis://redis:6379/0");
        document.setIn(["services", "app", "depends_on", "redis"], { condition: "service_healthy" });
      });
    } else {
      this.fs.append(this.destinationPath("src/server/core/db/schema/app_schema.ts"), '\n// Export the owning schema as well as its table so fresh migrations create both.\nexport { utilsSchema } from "@kestrel/framework/db";\nexport { cacheEntries } from "@kestrel/framework/cache/postgres_schema";\n');
      replaceSource(this, "src/server/core/db/seed.ts", 'schemas: ["public", "dev", "drizzle"]', 'schemas: ["public", "utils", "dev", "drizzle"]');
      replaceSource(this, "README.md", '`public`, `dev`, and migration-journal schemas', '`public`, `utils`, `dev`, and migration-journal schemas');
      this.fs.copy(`${templates}/postgres-migrations`, this.destinationPath("src/server/core/db/migrations"));
    }

    this.fs.append(this.destinationPath("README.md"), redis
      ? '\n## Redis cache\n\nThe application registers `RedisCacheProvider` with the framework Redis adapter. `REDIS_URL` selects the connection; local development defaults to `redis://127.0.0.1:56379/0`, tests default to database 2, and stage/prod require an explicit URL. Connections open on the first cache operation and close with the application. Redis supplies native expiration; this adapter does not support cache tags. `npm run infra:up` includes Redis, and the devcontainer uses its service hostname.\n'
      : '\n## PostgreSQL cache\n\nThe application registers the framework `CacheProvider` with its PostgreSQL adapter. `npm run db:migrate` installs the included migration for `utils.cache_entry`, with expiration indexes, cache tags and the UNLOGGED contribution. Cache contents are recomputable and may be lost after a database crash. Local reset also recreates the application-owned `utils` schema.\n');
    this.fs.append(this.destinationPath("README.md"), '\nCache settings live in `src/server/core/config/cache.ts`. Inject `cacheDependency` from `@kestrel/framework/cache` into actions to use the configured cache. PostgreSQL supports `tagAwareCacheDependency`; Redis does not. The starter does not install a scheduled-task runtime, so automatic PostgreSQL pruning is disabled; arrange pruning before production use, for example by scheduling the cache resource’s `prune()` operation.\n');
  }
}
