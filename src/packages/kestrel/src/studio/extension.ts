import type { HttpController } from "../http/index.js";
import type { SvgIconDefinition } from "./icon_definition.js";

/**
 * Describes one page contributed to the Studio navigation and router.
 */
export interface StudioPageDefinition {
  id: string;
  title: string;
  path: `/${string}`;
  description?: string;
  /** Selects the client-side renderer used for this page. */
  kind: string;
  /** Optional endpoint, relative to the Studio base path, used by the page. */
  dataPath?: `/${string}`;
  /** Hidden pages remain routable but do not appear in Studio navigation. */
  showInNavigation?: boolean;
  /** Sorts this page within its navigation section. */
  order?: number;
  /** Supplies a serializable icon that Studio adds to its deduplicated catalog. */
  icon?: SvgIconDefinition;
}

/** Identifies and orders one group in the Studio sidebar. */
export interface StudioNavigationSectionDefinition {
  id: string;
  title: string;
  order?: number;
}

/** References a section by id/title, or defines it when it does not exist. */
export type StudioNavigationSectionReference =
  | string
  | StudioNavigationSectionDefinition;

/**
 * Describes a development tool that opens outside the Studio router.
 */
export interface StudioExternalLinkDefinition {
  id: string;
  title: string;
  description?: string;
  href: string;
  /** Sorts this link within its navigation section. */
  order?: number;
  /** Supplies a serializable icon that Studio adds to its deduplicated catalog. */
  icon?: SvgIconDefinition;
}

/** Client page definition whose icon points into the manifest icon catalog. */
export type StudioPageManifest = Omit<StudioPageDefinition, "icon"> & {
  icon?: string;
};

/** Client external link whose icon points into the manifest icon catalog. */
export type StudioExternalLinkManifest = Omit<
  StudioExternalLinkDefinition,
  "icon"
> & {
  icon?: string;
};

/**
 * Serializable extension data consumed by the Studio client application.
 */
export interface StudioExtensionManifest {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  section: StudioNavigationSectionDefinition;
  pages: readonly StudioPageManifest[];
  links?: readonly StudioExternalLinkManifest[];
}

export interface StudioHttpControllerContext {
  basePath: string;
}

/** Heterogeneous controller type used by extension-owned HTTP catalogs. */
export type StudioHttpController = HttpController<
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * Adds navigation, pages and optional JSON APIs to Studio.
 */
export interface StudioExtension {
  id: string;
  title: string;
  description?: string;
  /** Supplies the serializable icon shown on the Studio overview. */
  icon?: SvgIconDefinition;
  /** Groups this extension's pages and links with other Studio tools. */
  section?: StudioNavigationSectionReference;
  pages: readonly StudioPageDefinition[];
  links?: readonly StudioExternalLinkDefinition[];
  defineHttpControllers?(
    context: StudioHttpControllerContext,
  ):
    | readonly StudioHttpController[]
    | Promise<readonly StudioHttpController[]>;
}

/**
 * Full client manifest exposed by Studio's discovery endpoint.
 */
export interface StudioManifest {
  basePath: string;
  icons: Readonly<Record<string, SvgIconDefinition>>;
  extensions: readonly StudioExtensionManifest[];
}
