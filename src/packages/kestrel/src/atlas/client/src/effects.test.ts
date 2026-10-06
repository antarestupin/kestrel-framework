import { describe, expect, it } from "vitest";

import {
  getAtlasActionFeedbackMessages,
  getAtlasNotificationSwipeDirections,
  resolveAtlasActionSuccess,
} from "./effects.js";

describe("atlas Action feedback", () => {
  it("uses label-safe defaults and accepts static overrides", () => {
    expect(getAtlasActionFeedbackMessages({
      label: "Send welcome email",
    })).toEqual({
      loading: "Running “Send welcome email”…",
      success: "“Send welcome email” completed.",
      error: "“Send welcome email” failed.",
    });
    expect(getAtlasActionFeedbackMessages({
      label: "Send welcome email",
      feedback: {
        loading: "Queuing welcome email…",
        success: "Welcome email queued.",
        error: "Welcome email could not be queued.",
      },
    })).toEqual({
      loading: "Queuing welcome email…",
      success: "Welcome email queued.",
      error: "Welcome email could not be queued.",
    });
  });

  it("uses one server success notification as the final promise toast", () => {
    const redirect = {
      type: "redirect" as const,
      target: { resource: "user", recordId: "user-1" },
    };
    const additionalNotification = {
      type: "notification" as const,
      level: "info" as const,
      message: "The user list will refresh shortly.",
    };
    const link = {
      label: "Open user",
      target: { resource: "user", recordId: "user-1" },
    };
    const resolved = resolveAtlasActionSuccess([
      redirect,
      {
        type: "notification",
        level: "success",
        message: "Dynamic success message.",
        link,
      },
      additionalNotification,
    ], "Static success message.");

    expect(resolved).toEqual({
      message: "Dynamic success message.",
      link,
      remainingEffects: [redirect, additionalNotification],
    });
  });

  it("dismisses each stack toward its nearest viewport edges", () => {
    expect(getAtlasNotificationSwipeDirections("top-left"))
      .toEqual(["up", "left"]);
    expect(getAtlasNotificationSwipeDirections("top-right"))
      .toEqual(["up", "right"]);
    expect(getAtlasNotificationSwipeDirections("bottom-left"))
      .toEqual(["down", "left"]);
    expect(getAtlasNotificationSwipeDirections("bottom-right"))
      .toEqual(["down", "right"]);
  });
});
