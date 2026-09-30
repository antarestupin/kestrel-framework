import Generator from "yeoman-generator";
import { updateInfrastructure } from "../files.mjs";

/** Add a development-only UI when any composed feature has installed Redis. */
export default class RedisInsightGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    updateInfrastructure(this, (document) => {
      if (!document.hasIn(["services", "redis"])) throw new Error("Redis Insight requires Redis.");
      document.setIn(["services", "redis-insight"], {
        image: "redis/redisinsight:3.8.0", ports: ["127.0.0.1:5540:5540"],
        environment: { RI_REDIS_HOST: "redis", RI_REDIS_PORT: "6379", RI_REDIS_ALIAS: this.options.applicationName },
        volumes: ["redis-insight-data:/data"],
        depends_on: { redis: { condition: "service_healthy" } },
      });
      document.setIn(["volumes", "redis-insight-data"], null);
    });
    this.fs.append(this.destinationPath("README.md"), "\n## Redis Insight\n\n`npm run infra:up` also starts Redis Insight. Open http://127.0.0.1:5540 and accept its first-run terms to browse the preconfigured local Redis connection. The UI is bound to the host loopback interface and stores its settings in the `redis-insight-data` volume. It is development tooling; deploy only the application and its runtime services. `npm run infra:down` stops it without deleting that volume.\n");
  }
}
