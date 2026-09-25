import { expect, it } from "vitest";
import { createApp } from "../core/app.js";

it("serves and validates the example operation without a network listener", async () => {
  const { app, runtime } = createApp({ web: false });
  try {
    const response = await runtime.server.inject({ method: "GET", url: "/api/greet?name=Sam" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "Hello, Sam!" });
    expect((await runtime.server.inject({ method: "GET", url: "/api/greet" })).statusCode).toBe(400);
  } finally {
    await runtime.stop();
    await app.dispose();
  }
});
