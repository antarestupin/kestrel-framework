import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { getStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import { studioClientExtension } from "./definition.js";
import "./index.js";

describe("Studio email renderer registration", () => {
  it("registers a renderable page for every declared email kind", () => {
    expect(studioClientExtension.pageKinds).toEqual([
      "development-email-history", "development-email-inbox", "development-email-capture",
    ]);
    for (const kind of studioClientExtension.pageKinds) {
      const renderer = getStudioPageRenderer(kind);
      expect(renderer?.kind).toBe(kind);
      expect(isValidElement(renderer?.render({ id: "email", kind, path: "/emails", title: "Email" }))).toBe(true);
    }
  });
});
