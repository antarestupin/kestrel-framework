import { expect, it } from "vitest";
import type { AtlasResourceManifest } from "../../contract.js";
import { groupNavigationResources } from "./navigation.js";

it("groups interleaved resources once, preserving section and resource declaration order", () => {
  const resources: (Pick<AtlasResourceManifest, "navigationGroup"> & { id: string })[] = [
    { id: "topic", navigationGroup: "Topics" },
    { id: "member" },
    { id: "room", navigationGroup: "Rooms" },
    { id: "response", navigationGroup: "Topics" },
    { id: "tag" },
  ];
  expect(groupNavigationResources(resources).map((group) => ({ label: group.label, ids: group.resources.map((resource) => resource.id) }))).toEqual([
    { label: "Topics", ids: ["topic", "response"] },
    { label: undefined, ids: ["member", "tag"] },
    { label: "Rooms", ids: ["room"] },
  ]);
  expect(resources.map(({ id }) => id)).toEqual(["topic", "member", "room", "response", "tag"]);
});

it("retains flat navigation without configuration and handles empty catalogs", () => {
  expect(groupNavigationResources([{ id: "first" }, { id: "second" }] as (Pick<AtlasResourceManifest, "navigationGroup"> & { id: string })[]))
    .toEqual([{ label: undefined, resources: [{ id: "first" }, { id: "second" }] }]);
  expect(groupNavigationResources([])).toEqual([]);
});
