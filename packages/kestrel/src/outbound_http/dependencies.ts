import { dep } from "../di/index.js";
import type { OutboundHttpClientFactory } from "./types.js";

/** Application-owned factory that attaches ambient request observations. */
export const outboundHttpClientFactoryDependency =
  dep<OutboundHttpClientFactory>("outboundHttpClientFactory");
