import { createPublicClient } from "../generated/publicClient/publicClient.js";

/** Same-origin typed client shared by browser features. */
export const api = createPublicClient({ baseUrl: "" });
