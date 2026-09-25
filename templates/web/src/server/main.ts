import { createApp } from "./core/app.js";

const { app, runtime } = createApp();
try {
  await runtime.run();
} finally {
  await app.dispose();
}
