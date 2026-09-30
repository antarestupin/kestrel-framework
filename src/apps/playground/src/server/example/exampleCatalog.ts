import { defineCatalog } from "@kestrel/framework/app";
import { greet, greetHttp } from "./greet.js";

/** Keeps example definitions together; appCatalog only composes feature catalogs. */
export const exampleCatalog = defineCatalog({
  actions: {
    greet,
  },
  controllers: {
    http: {
      greet: greetHttp,
    },
  },
});
