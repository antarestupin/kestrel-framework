import { describe, expect, it } from "vitest";

import { formatObservationDuration } from "./observation_format.js";

describe("formatObservationDuration", () => {
  it("formats missing, sub-millisecond, precise and rounded durations", () => {
    expect(formatObservationDuration(null)).toBe("running");
    expect(formatObservationDuration(0.5)).toBe("<1 ms");
    expect(formatObservationDuration(1.25)).toBe("1.3 ms");
    expect(formatObservationDuration(12.5)).toBe("13 ms");
  });
});
