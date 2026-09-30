// Creates the shared typed HTTP client used by browser features.
// Configure client transport options here and regenerate contracts with npm run api:generate.

import { createPublicClient } from "../../generated/publicClient/publicClient.js";

/** Same-origin typed client shared by browser features. */
export const api = createPublicClient({ baseUrl: "" });
