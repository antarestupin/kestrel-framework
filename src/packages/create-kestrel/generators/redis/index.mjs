import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";
import { replaceSource, updateInfrastructure } from "../files.mjs";
import { createApplicationNames } from "../application_names.mjs";

/** Install shared Redis infrastructure and its development UI once for all consumers. */
export default class RedisGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    const templates = fileURLToPath(new URL("./templates/", import.meta.url));
    this.fs.copy(`${templates}/redis.ts`, this.destinationPath("src/server/core/config/redis.ts"));
    this.fs.copy(`${templates}/redis_provider.ts`, this.destinationPath("src/server/core/providers/redis_provider.ts"));
    this.fs.copy(`${templates}/redis_provider.test.ts.ejs`, this.destinationPath("src/server/core/providers/redis_provider.test.ts"));
    replaceSource(this, "src/server/core/app_config.ts", 'import { createLoggerConfig } from "./config/logger.js";',
      'import { createLoggerConfig } from "./config/logger.js";\nimport { createRedisConfig } from "./config/redis.js";');
    replaceSource(this, "src/server/core/app_config.ts", "  logger: createLoggerConfig(configurationApi),",
      "  logger: createLoggerConfig(configurationApi),\n  redis: createRedisConfig(configurationApi),");
    replaceSource(this, "src/server/core/app.ts", 'import { PostgresDrizzleProvider } from "./providers/database_provider.js";',
      'import { PostgresDrizzleProvider } from "./providers/database_provider.js";\nimport { RedisProvider } from "./providers/redis_provider.js";');
    replaceSource(this, "src/server/core/app.ts", "  .register(new PostgresDrizzleProvider(app.config.database, environment))",
      "  .register(new PostgresDrizzleProvider(app.config.database, environment))\n  .register(new RedisProvider(app.config.redis))");
    const manifestPath = this.destinationPath("package.json");
    const manifest = this.fs.readJSON(manifestPath);
    manifest.dependencies["@redis/client"] = "^6.2.1";
    this.fs.writeJSON(manifestPath, manifest);
    this.fs.append(this.destinationPath(".env.example"), "\n# Shared Redis connection; test runs use database 2 when no override is supplied.\nREDIS_URL=redis://127.0.0.1:56379/0\n");
    updateInfrastructure(this, (document) => {
      // A shared instance must not evict locks or other coordination keys under memory pressure.
      if (!document.hasIn(["services", "redis"])) document.setIn(["services", "redis"], {
        image: "redis:8-alpine", ports: ["127.0.0.1:56379:6379"],
        command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction"],
        tmpfs: ["/data"],
        healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: "5s", timeout: "3s", retries: 10 },
      });
      document.setIn(["services", "app", "environment", "REDIS_URL"], "redis://redis:6379/0");
      document.setIn(["services", "app", "depends_on", "redis"], { condition: "service_healthy" });
      document.setIn(["services", "redis-insight"], {
        image: "redis/redisinsight:3.8.0", ports: ["127.0.0.1:5540:5540"],
        environment: { RI_REDIS_HOST: "redis", RI_REDIS_PORT: "6379", RI_REDIS_ALIAS: createApplicationNames(this.options.applicationName).displayName },
        volumes: ["redis-insight-data:/data"],
        depends_on: { redis: { condition: "service_healthy" } },
      });
      document.setIn(["volumes", "redis-insight-data"], null);
    });
    this.fs.append(this.destinationPath("README.md"), '\n## Shared Redis connection\n\n`RedisProvider` owns one lazy connection shared by features through `redisDependency` from `src/server/core/providers/redis_provider.ts`. `REDIS_URL` selects the connection; local development defaults to `redis://127.0.0.1:56379/0`, tests default to database 2, and stage/prod require an explicit URL. Connections open on the first command and close with the application. `npm run infra:up` includes Redis, and the devcontainer uses its service hostname. The local instance uses `noeviction` so memory pressure rejects writes instead of prematurely removing coordination keys; TTL expiration remains active. It is ephemeral development infrastructure.\n\nTo isolate a feature, declare another `dep<RedisClient>("cacheRedis")`, register a `RedisProvider` with its configuration and that descriptor, and pass the descriptor to the consuming provider. Native LRU requires a separate Redis instance configured for cache eviction; another connection, key prefix or logical database on the shared instance does not isolate eviction.\n');
    this.fs.append(this.destinationPath("README.md"), "\n## Redis Insight\n\n`npm run infra:up` also starts Redis Insight. Open http://127.0.0.1:5540 and accept its first-run terms to browse the preconfigured local Redis connection. The UI is bound to the host loopback interface and stores its settings in the `redis-insight-data` volume. It is development tooling; deploy only the application and its runtime services. `npm run infra:down` stops it without deleting that volume.\n");
  }
}
