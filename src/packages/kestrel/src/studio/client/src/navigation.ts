import type {
  StudioExternalLinkManifest,
  StudioManifest,
  StudioNavigationSectionDefinition,
  StudioPageManifest,
} from "../../extension.js";

export type StudioNavigationItem =
  | {
      type: "page";
      key: string;
      definition: StudioPageManifest;
      insertionIndex: number;
    }
  | {
      type: "link";
      key: string;
      definition: StudioExternalLinkManifest;
      insertionIndex: number;
    };

export interface StudioNavigationSection {
  definition: StudioNavigationSectionDefinition;
  items: readonly StudioNavigationItem[];
  insertionIndex: number;
}

/** Groups resources contributed by distinct extensions into shared sections. */
export function buildStudioNavigation(
  manifest: StudioManifest,
): readonly StudioNavigationSection[] {
  const sections = new Map<string, {
    definition: StudioNavigationSectionDefinition;
    items: StudioNavigationItem[];
    insertionIndex: number;
  }>();
  let itemIndex = 0;

  for (const extension of manifest.extensions) {
    let section = sections.get(extension.section.id);

    if (section === undefined) {
      section = {
        definition: extension.section,
        items: [],
        insertionIndex: sections.size,
      };
      sections.set(extension.section.id, section);
    }

    for (const page of extension.pages) {
      if (page.showInNavigation !== false) {
        section.items.push({
          type: "page",
          key: `${extension.id}.page.${page.id}`,
          definition: page,
          insertionIndex: itemIndex++,
        });
      }
    }

    for (const link of extension.links ?? []) {
      section.items.push({
        type: "link",
        key: `${extension.id}.link.${link.id}`,
        definition: link,
        insertionIndex: itemIndex++,
      });
    }
  }

  return [...sections.values()]
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      ...section,
      items: section.items.toSorted(compareNavigationItems),
    }))
    .toSorted((first, second) =>
      compareOrder(
        first.definition.order,
        second.definition.order,
        first.insertionIndex,
        second.insertionIndex,
      ));
}

function compareNavigationItems(
  first: StudioNavigationItem,
  second: StudioNavigationItem,
): number {
  return compareOrder(
    first.definition.order,
    second.definition.order,
    first.insertionIndex,
    second.insertionIndex,
  );
}

function compareOrder(
  firstOrder: number | undefined,
  secondOrder: number | undefined,
  firstInsertionIndex: number,
  secondInsertionIndex: number,
): number {
  return (firstOrder ?? Number.MAX_SAFE_INTEGER)
    - (secondOrder ?? Number.MAX_SAFE_INTEGER)
    || firstInsertionIndex - secondInsertionIndex;
}
