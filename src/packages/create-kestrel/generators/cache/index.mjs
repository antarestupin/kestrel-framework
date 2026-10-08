import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";
import { replaceSource } from "../files.mjs";

/** Compose one cache backend; PostgreSQL remains the application's database in either case. */
export default class CacheGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    const redis = this.options.cache === "redis";
    const templates = fileURLToPath(new URL("./templates/", import.meta.url));
    this.fs.copyTpl(`${templates}/cache.ts.ejs`, this.destinationPath("src/server/core/config/cache.ts"), this.options);
    replaceSource(this, "src/server/core/app_config.ts", 'import { createLoggerConfig } from "./config/logger.js";',
      'import { createLoggerConfig } from "./config/logger.js";\nimport { createCacheConfig } from "./config/cache.js";');
    replaceSource(this, "src/server/core/app_config.ts", "  logger: createLoggerConfig(configurationApi),",
      "  logger: createLoggerConfig(configurationApi),\n  cache: createCacheConfig(),");
    replaceSource(this, "src/server/core/app.ts", 'import { DatabaseProvider } from "./providers/database_provider.js";',
      (redis ? 'import { DatabaseProvider } from "./providers/database_provider.js";\n'
        : 'import { DatabaseProvider, databaseDependency } from "./providers/database_provider.js";\n')
      + (redis ? 'import { CacheProvider, redisCache } from "@kestreljs/framework/cache";\nimport { redisDependency } from "./providers/redis_provider.js";' : 'import { CacheProvider, postgresCache } from "@kestreljs/framework/cache";'));
    replaceSource(this, "src/server/core/app.ts", "  .register(new DatabaseProvider(app.config.database, environment))",
      "  .register(new DatabaseProvider(app.config.database, environment))\n"
      + (redis ? '  .register(new CacheProvider(app.config.cache, redisCache(redisDependency, app.config.cache.adapter)))' : '  .register(new CacheProvider(app.config.cache, postgresCache(databaseDependency, app.config.cache.adapter)))'));

    if (redis) {
      this.fs.copy(`${templates}/cache.test.ts.ejs`, this.destinationPath("src/server/core/cache.test.ts"));
    } else {
      this.fs.append(this.destinationPath("src/server/core/db/schema/app_schema.ts"), '\n// Export the owning schema as well as its table so fresh migrations create both.\nexport { utilsSchema } from "@kestreljs/framework/db";\nexport { cacheEntries } from "@kestreljs/framework/cache/postgres_schema";\n');
      replaceSource(this, "src/server/core/db/seed.ts", 'schemas: ["public", "dev", "drizzle"]', 'schemas: ["public", "utils", "dev", "drizzle"]');
      replaceSource(this, "README.md", '`public`, `dev`, and migration-journal schemas', '`public`, `utils`, `dev`, and migration-journal schemas');
      this.fs.copy(`${templates}/postgres-migrations`, this.destinationPath("src/server/core/db/migrations"));
    }

    this.fs.append(this.destinationPath("README.md"), redis
      ? '\n## Redis cache\n\nThe application registers `CacheProvider` with the `redisCache()` adapter definition. It borrows the shared `redisDependency` connection owned by `RedisProvider`; pass another Redis dependency descriptor to `redisCache(connection)` to use a dedicated connection. Redis supplies native expiration; this adapter does not support cache tags.\n'
      : '\n## PostgreSQL cache\n\nThe application registers the framework `CacheProvider` with its PostgreSQL adapter. `npm run db:migrate` installs the included migration for `utils.cache_entry`, with expiration indexes, cache tags and the UNLOGGED contribution. Cache contents are recomputable and may be lost after a database crash. Local reset also recreates the application-owned `utils` schema.\n');
    this.fs.append(this.destinationPath("README.md"), '\nCache settings live in `src/server/core/config/cache.ts`; the nested `adapter` contribution validates backend settings separately. PostgreSQL borrows the typed `databaseDependency` exported by the database provider. Inject `cacheDependency` from `@kestreljs/framework/cache` into actions to use the configured cache. PostgreSQL supports `tagAwareCacheDependency`; Redis does not. The starter does not install a scheduled-task runtime, so automatic PostgreSQL pruning is disabled; arrange pruning before production use, for example by scheduling the cache resource’s `prune()` operation.\n');
  }
}
