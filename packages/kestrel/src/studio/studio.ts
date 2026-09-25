import {
  defineHttpController,
  get,
} from "../http/index.js";
import { studioHttpAccess } from "./http_access.js";
import type {
  StudioExternalLinkDefinition,
  StudioExtension,
  StudioExtensionManifest,
  StudioHttpController,
  StudioManifest,
  StudioNavigationSectionDefinition,
  StudioPageDefinition,
} from "./extension.js";
import { IconCatalogBuilder } from "./icon_catalog.js";

export const DEFAULT_STUDIO_BASE_PATH = "/_studio";

export interface StudioOptions {
  basePath?: string;
  extensions?: readonly StudioExtension[];
}

/**
 * Owns Studio configuration and coordinates its registered extensions.
 */
export class Studio {
  public readonly basePath: string;
  public readonly extensions: readonly StudioExtension[];
  private readonly navigationSections: ReadonlyMap<
    StudioExtension,
    StudioNavigationSectionDefinition
  >;
  private manifest?: StudioManifest;

  public constructor(options: StudioOptions = {}) {
    this.basePath = normalizeStudioBasePath(
      options.basePath ?? DEFAULT_STUDIO_BASE_PATH,
    );
    this.extensions = [...(options.extensions ?? [])];

    validateExtensions(this.extensions);
    this.navigationSections = resolveNavigationSections(this.extensions);
  }

  /**
   * Returns the serializable catalog used to build the client-side router.
   */
  public getManifest(): StudioManifest {
    if (this.manifest !== undefined) {
      return this.manifest;
    }

    const icons = new IconCatalogBuilder();
    const extensions = this.extensions.map((extension) =>
      toExtensionManifest(
        extension,
        this.basePath,
        this.navigationSections.get(extension)!,
        icons,
      ));

    this.manifest = {
      basePath: this.basePath,
      icons: icons.toManifest(),
      extensions,
    };
    return this.manifest;
  }

  /**
   * Builds the manifest endpoint and extension-owned JSON API controllers.
   */
  public async defineHttpControllers(): Promise<
    readonly StudioHttpController[]
  > {
    const controllers: StudioHttpController[] = [
      defineHttpController({
        access: studioHttpAccess,
        route: get(joinStudioPath(this.basePath, "/api/manifest")),
        description: "Expose the Studio client manifest.",
        handler: () => this.getManifest(),
      }),
    ];

    for (const extension of this.extensions) {
      const extensionControllers =
        await extension.defineHttpControllers?.({
          basePath: this.basePath,
        });

      if (extensionControllers !== undefined) {
        controllers.push(...extensionControllers);
      }
    }

    return controllers;
  }
}

/**
 * Joins a Studio-relative route to its configurable mount point.
 */
export function joinStudioPath(
  basePath: string,
  relativePath: `/${string}`,
): string {
  return basePath === "/"
    ? relativePath
    : `${basePath}${relativePath}`;
}

function normalizeStudioBasePath(basePath: string): string {
  const trimmedPath = basePath.trim();

  if (
    !trimmedPath.startsWith("/")
    || trimmedPath.includes("?")
    || trimmedPath.includes("#")
    || trimmedPath.includes("*")
  ) {
    throw new TypeError(
      "The Studio base path must be an absolute URL path without a query, fragment or wildcard.",
    );
  }

  if (trimmedPath === "/") {
    return trimmedPath;
  }

  return trimmedPath.replace(/\/+$/u, "");
}

function validateExtensions(
  extensions: readonly StudioExtension[],
): void {
  const extensionIds = new Set<string>();
  const linkIds = new Set<string>();
  const pageIds = new Set<string>();
  const pagePaths = new Set<string>();

  for (const extension of extensions) {
    validateIdentifier(extension.id, "extension");

    if (extensionIds.has(extension.id)) {
      throw new TypeError(
        `Studio extension id "${extension.id}" is registered more than once.`,
      );
    }

    extensionIds.add(extension.id);

    for (const page of extension.pages) {
      validatePage(page, extension.id);

      const qualifiedPageId = `${extension.id}.${page.id}`;

      if (pageIds.has(qualifiedPageId)) {
        throw new TypeError(
          `Studio page id "${qualifiedPageId}" is registered more than once.`,
        );
      }

      if (pagePaths.has(page.path)) {
        throw new TypeError(
          `Studio page path "${page.path}" is registered more than once.`,
        );
      }

      pageIds.add(qualifiedPageId);
      pagePaths.add(page.path);
    }

    for (const link of extension.links ?? []) {
      validateExternalLink(link, extension.id);

      const qualifiedLinkId = `${extension.id}.${link.id}`;

      if (linkIds.has(qualifiedLinkId)) {
        throw new TypeError(
          `Studio link id "${qualifiedLinkId}" is registered more than once.`,
        );
      }

      linkIds.add(qualifiedLinkId);
    }
  }
}

function resolveNavigationSections(
  extensions: readonly StudioExtension[],
): ReadonlyMap<StudioExtension, StudioNavigationSectionDefinition> {
  const sectionsById = new Map<string, StudioNavigationSectionDefinition>();
  const sectionIdsByTitle = new Map<string, string>();

  // Register explicit definitions first so references do not depend on the
  // order in which extensions are installed.
  for (const extension of extensions) {
    if (typeof extension.section === "object") {
      registerNavigationSection(
        extension.section,
        sectionsById,
        sectionIdsByTitle,
      );
    }
  }

  // Extensions without an explicit reference use their identity as a section
  // definition, while matching an existing id or title when one is available.
  for (const extension of extensions) {
    if (extension.section === undefined) {
      const existingId = sectionsById.has(extension.id)
        ? extension.id
        : sectionIdsByTitle.get(extension.title.trim().toLocaleLowerCase());

      if (existingId === undefined) {
        registerNavigationSection(
          { id: extension.id, title: extension.title },
          sectionsById,
          sectionIdsByTitle,
        );
      }
    }
  }

  const sections = new Map<StudioExtension, StudioNavigationSectionDefinition>();

  for (const extension of extensions) {
    sections.set(
      extension,
      resolveExtensionNavigationSection(
        extension,
        sectionsById,
        sectionIdsByTitle,
      ),
    );
  }

  return sections;
}

function resolveExtensionNavigationSection(
  extension: StudioExtension,
  sectionsById: Map<string, StudioNavigationSectionDefinition>,
  sectionIdsByTitle: Map<string, string>,
): StudioNavigationSectionDefinition {
  const reference = extension.section;

  if (reference === undefined) {
    const sectionId = sectionsById.has(extension.id)
      ? extension.id
      : sectionIdsByTitle.get(extension.title.trim().toLocaleLowerCase())!;

    return sectionsById.get(sectionId)!;
  }

  if (typeof reference === "string") {
    return resolveNavigationSectionReference(
      reference,
      sectionsById,
      sectionIdsByTitle,
    );
  }

  return sectionsById.get(reference.id)
    ?? registerNavigationSection(
      reference,
      sectionsById,
      sectionIdsByTitle,
    );
}

function registerNavigationSection(
  section: StudioNavigationSectionDefinition,
  sectionsById: Map<string, StudioNavigationSectionDefinition>,
  sectionIdsByTitle: Map<string, string>,
): StudioNavigationSectionDefinition {
  validateIdentifier(section.id, "navigation section");
  validateNavigationOrder(
    section.order,
    `navigation section "${section.id}"`,
  );

  if (section.title.trim() === "") {
    throw new TypeError(
      `Studio navigation section "${section.id}" must have a title.`,
    );
  }

  const normalizedTitle = section.title.trim();
  const titleKey = normalizedTitle.toLocaleLowerCase();
  const existing = sectionsById.get(section.id);
  const existingIdForTitle = sectionIdsByTitle.get(titleKey);

  if (existingIdForTitle !== undefined && existingIdForTitle !== section.id) {
    throw new TypeError(
      `Studio navigation section title "${normalizedTitle}" is used by more than one id.`,
    );
  }

  if (existing !== undefined) {
    if (
      existing.title !== normalizedTitle
      || (
        existing.order !== undefined
        && section.order !== undefined
        && existing.order !== section.order
      )
    ) {
      throw new TypeError(
        `Studio navigation section "${section.id}" has conflicting definitions.`,
      );
    }

    if (existing.order === undefined && section.order !== undefined) {
      const orderedSection = { ...existing, order: section.order };

      sectionsById.set(section.id, orderedSection);
      return orderedSection;
    }

    return existing;
  }

  const normalizedSection = {
    id: section.id,
    title: normalizedTitle,
    ...(section.order === undefined ? {} : { order: section.order }),
  };

  sectionsById.set(section.id, normalizedSection);
  sectionIdsByTitle.set(titleKey, section.id);
  return normalizedSection;
}

function resolveNavigationSectionReference(
  reference: string,
  sectionsById: Map<string, StudioNavigationSectionDefinition>,
  sectionIdsByTitle: Map<string, string>,
): StudioNavigationSectionDefinition {
  const normalizedReference = reference.trim();

  if (normalizedReference === "") {
    throw new TypeError("A Studio navigation section reference cannot be empty.");
  }

  const referencedId = sectionsById.has(normalizedReference)
    ? normalizedReference
    : sectionIdsByTitle.get(normalizedReference.toLocaleLowerCase());

  if (referencedId !== undefined) {
    return sectionsById.get(referencedId)!;
  }

  // An unknown reference creates a section. Human-readable references keep
  // their title, while kebab-case identifiers receive a readable title.
  const id = toNavigationSectionId(normalizedReference);
  const title = normalizedReference === id
    ? id.split("-").map(capitalize).join(" ")
    : normalizedReference;

  return registerNavigationSection(
    { id, title },
    sectionsById,
    sectionIdsByTitle,
  );
}

function toNavigationSectionId(reference: string): string {
  const id = reference
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  validateIdentifier(id, "navigation section");
  return id;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}`;
}

function validateExternalLink(
  link: StudioExternalLinkDefinition,
  extensionId: string,
): void {
  validateIdentifier(link.id, `link in extension "${extensionId}"`);
  validateNavigationOrder(
    link.order,
    `link "${extensionId}.${link.id}"`,
  );

  let url: URL;

  try {
    url = new URL(link.href);
  } catch {
    throw new TypeError(
      `Studio link "${extensionId}.${link.id}" must use an absolute HTTP URL.`,
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new TypeError(
      `Studio link "${extensionId}.${link.id}" must use an absolute HTTP URL without credentials.`,
    );
  }
}

function validatePage(
  page: StudioPageDefinition,
  extensionId: string,
): void {
  validateIdentifier(page.id, `page in extension "${extensionId}"`);
  validateNavigationOrder(
    page.order,
    `page "${extensionId}.${page.id}"`,
  );

  if (
    !page.path.startsWith("/")
    || page.path.includes("//")
    || page.path === "/"
    || page.path.endsWith("/")
    || page.path.includes("?")
    || page.path.includes("#")
    || page.path.includes("*")
  ) {
    throw new TypeError(
      `Studio page "${extensionId}.${page.id}" must use a non-root absolute path without a trailing slash, query, fragment or wildcard.`,
    );
  }

  if (
    page.dataPath !== undefined
    && (
      !page.dataPath.startsWith("/")
      || page.dataPath.includes("//")
      || page.dataPath.includes("?")
      || page.dataPath.includes("#")
      || page.dataPath.includes("*")
    )
  ) {
    throw new TypeError(
      `Studio page "${extensionId}.${page.id}" data path must be an absolute path without a query, fragment or wildcard.`,
    );
  }
}

function validateIdentifier(
  identifier: string,
  subject: string,
): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(identifier)) {
    throw new TypeError(
      `The Studio ${subject} id "${identifier}" must use lowercase kebab-case.`,
    );
  }
}

function validateNavigationOrder(
  order: number | undefined,
  subject: string,
): void {
  if (order !== undefined && !Number.isFinite(order)) {
    throw new TypeError(`Studio ${subject} order must be a finite number.`);
  }
}

function toExtensionManifest(
  extension: StudioExtension,
  basePath: string,
  section: StudioNavigationSectionDefinition,
  icons: IconCatalogBuilder,
): StudioExtensionManifest {
  return {
    id: extension.id,
    title: extension.title,
    ...(extension.description === undefined
      ? {}
      : { description: extension.description }),
    ...(extension.icon === undefined ? {} : { icon: icons.add(extension.icon) }),
    section,
    pages: extension.pages.map((page) => {
      const { icon, ...definition } = page;

      return {
        ...definition,
        ...(icon === undefined ? {} : { icon: icons.add(icon) }),
        ...(page.dataPath === undefined
          ? {}
          : {
              dataPath: joinStudioPath(
                basePath,
                page.dataPath,
              ) as `/${string}`,
            }),
      };
    }),
    ...(extension.links === undefined
      ? {}
      : {
          links: extension.links.map((link) => {
            const { icon, ...definition } = link;

            return {
              ...definition,
              ...(icon === undefined ? {} : { icon: icons.add(icon) }),
            };
          }),
        }),
  };
}
