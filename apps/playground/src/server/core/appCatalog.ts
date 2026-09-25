import { defineCatalog, selectHttpControllerCatalog } from "@kestrel/framework/app";
import { greet, greetHttp } from "../example/greet.js";

export const appCatalog = defineCatalog({ example: { actions: { greet }, controllers: { http: { greet: greetHttp } } } });
export const applicationHttpControllerCatalog = selectHttpControllerCatalog(appCatalog);
