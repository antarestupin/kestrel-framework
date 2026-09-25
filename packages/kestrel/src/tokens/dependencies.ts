import { dep } from "../di/index.js";
import type { TokenManager } from "./manager.js";
import type { TokenStore } from "./types.js";

export const tokenManagerDependency = dep<TokenManager>("tokenManager");
export const tokenStoreDependency = dep<TokenStore>("tokenStore");
