import { dep } from "../di/index.js";
import type { EventBus } from "./event_bus.js";

/** Application-owned in-memory event bus shared by every transport. */
export const eventBusDependency = dep<EventBus>("eventBus");
