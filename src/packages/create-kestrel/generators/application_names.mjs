import { createHash } from "node:crypto";

/** Derive context-specific names without renaming the user's destination directory. */
export function createApplicationNames(directoryName) {
  // Restrict substitutions to ASCII words and separators: all template contexts stay literal-safe.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(directoryName) || directoryName.length > 214) {
    throw new Error("Use a lowercase npm-compatible directory name of at most 214 characters.");
  }
  const words = directoryName.split(/[._-]+/).filter(Boolean);
  const applicationName = words.join("-");
  let databaseName = words.join("_");
  // PostgreSQL identifiers allow 63 bytes; reserve five for the dedicated test database suffix.
  // A stable hash distinguishes long names that would otherwise share a truncated prefix.
  if (databaseName.length > 58) {
    const hash = createHash("sha256").update(databaseName).digest("hex").slice(0, 8);
    databaseName = `${databaseName.slice(0, 49)}_${hash}`;
  }
  return {
    applicationName,
    displayName: words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    applicationInitial: words[0][0].toUpperCase(),
    databaseName,
    testDatabaseName: `${databaseName}_test`,
  };
}

/** Render explicit identity placeholders only; framework names and application identifiers stay intact. */
export function renderApplicationTemplate(source, names) {
  const values = {
    APPLICATION_NAME: names.applicationName,
    DISPLAY_NAME: names.displayName,
    APPLICATION_INITIAL: names.applicationInitial,
    DATABASE_NAME: names.databaseName,
    TEST_DATABASE_NAME: names.testDatabaseName,
  };
  return source.replace(/__KESTREL_([A-Z_]+)__/g, (_placeholder, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown application template placeholder: ${key}`);
    return values[key];
  });
}
