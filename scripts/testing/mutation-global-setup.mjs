import { provisionMutationDatabase } from "./mutation-databases.mjs";

/** Root global setup executes once before this Stryker worker creates Vitest forks. */
export default async function setup() {
  process.env.KESTREL_TEST_DATABASE = await provisionMutationDatabase();
  // The outer wrapper owns cleanup even when a worker times out or is terminated.
}
