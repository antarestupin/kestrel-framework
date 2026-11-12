import { expect, it } from "vitest";

import { serializeCacheValue } from "./serialization.js";

it("preserves a JSON serialization failure as the cause of the cache error", () => {
  const failure = new Error("cannot serialize");
  const value = { toJSON() { throw failure; } };

  try {
    serializeCacheValue(value);
    throw new Error("Expected serialization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "Cache values must be JSON serializable.", cause: failure });
  }
});
