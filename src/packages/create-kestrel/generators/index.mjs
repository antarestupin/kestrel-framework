import { createEnv } from "yeoman-environment";
import ApplicationGenerator from "./application/index.mjs";
import BaseGenerator from "./base/index.mjs";
import CacheGenerator from "./cache/index.mjs";
import RedisGenerator from "./redis/index.mjs";
import AtlasGenerator from "./atlas/index.mjs";

/** Register only bundled generators: application creation never discovers or installs plugins. */
export async function createApplication(options, adapter) {
  const environment = createEnv({
    cwd: process.cwd(), sharedOptions: { skipCache: true, localConfigOnly: true },
    ...(adapter ? { adapter } : {}),
  });
  environment.registerStub(ApplicationGenerator, "kestrel:application");
  environment.registerStub(BaseGenerator, "kestrel:base");
  environment.registerStub(CacheGenerator, "kestrel:cache");
  environment.registerStub(RedisGenerator, "kestrel:redis");
  environment.registerStub(AtlasGenerator, "kestrel:atlas");
  const logger = environment.adapter.log;
  const logCreatedFile = logger.create;
  // Hide per-file creation status while retaining prompts, diagnostics and the final summary.
  logger.create = () => logger;
  try {
    await environment.run("kestrel:application", { ...options, skipInstall: true });
  } finally {
    // Restore the logger when the caller supplied an adapter of its own.
    logger.create = logCreatedFile;
    // Release prompt resources even when validation fails or the user cancels.
    environment.adapter.close();
  }
}
