import { dep } from "../di/index.js";
import type { ErrorHandler } from "./error_handler.js";

/** Error handler resolved inside every transport execution scope. */
export const errorHandlerDependency = dep<ErrorHandler>(
  "errorHandler",
);
