import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./styles.css", import.meta.url),
  "utf8",
);

describe("atlas notification styles", () => {
  it("retains the Base UI stacking and transition state selectors", () => {
    for (const selector of [
      "--toast-index",
      "--toast-offset-y",
      ".notification[data-expanded]",
      ".notification[data-limited]",
      ".notification[data-swiping]",
      ".notification[data-starting-style]",
      ".notification[data-ending-style]",
      ".notification-content[data-behind]",
      ".notification-content[data-expanded]",
      "@media (prefers-reduced-motion: reduce)",
    ]) {
      expect(stylesheet).toContain(selector);
    }
  });
});

describe("atlas dialog styles", () => {
  it("animates both standard and confirmation dialogs through Base UI states", () => {
    for (const selector of [
      ".dialog-backdrop[data-starting-style]",
      ".dialog-backdrop[data-ending-style]",
      ".dialog-panel[data-starting-style]",
      ".dialog-panel[data-ending-style]",
      ".confirmation-panel[data-starting-style]",
      ".confirmation-panel[data-ending-style]",
      "transform: translateY(8px) scale(.96)",
    ]) {
      expect(stylesheet).toContain(selector);
    }
  });

  it("disables dialog transitions when reduced motion is requested", () => {
    const reducedMotionStyles = stylesheet.slice(
      stylesheet.indexOf("@media (prefers-reduced-motion: reduce)"),
    );

    for (const selector of [
      ".dialog-backdrop",
      ".dialog-panel",
      ".confirmation-panel",
      "transition-duration: 0ms",
    ]) {
      expect(reducedMotionStyles).toContain(selector);
    }
  });
});
