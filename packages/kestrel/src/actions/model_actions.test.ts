import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import type {
  CollectionQuery,
  PaginatedResult,
} from "../db/index.js";
import {
  defineModelCreateAction,
  defineModelDeleteAction,
  defineModelGetAction,
  defineModelGetManyAction,
  defineModelListAction,
  defineModelLookupAction,
  defineModelUpdateAction,
  type ModelActionRepository,
} from "./index.js";

interface TestModel {
  recordId: number;
  value: string;
}

interface CreateTestModelInput {
  value: string;
}

interface UpdateTestModelInput {
  value?: string;
}

interface ModelStore {
  records: TestModel[];
}

class TestModelRepository implements ModelActionRepository<
  TestModel,
  CreateTestModelInput,
  number,
  UpdateTestModelInput
> {
  public constructor(
    private readonly dependencies: {
      modelStore: ModelStore;
    },
  ) {}

  public async create(
    input: CreateTestModelInput,
  ): Promise<TestModel> {
    const model = {
      recordId: this.dependencies.modelStore.records.length + 1,
      ...input,
    };

    this.dependencies.modelStore.records.push(model);

    return model;
  }

  public async findById(id: number): Promise<TestModel | null> {
    return this.dependencies.modelStore.records.find(
      (model) => model.recordId === id,
    ) ?? null;
  }

  public async findManyByIds(ids: readonly number[]): Promise<TestModel[]> {
    const identifiers = new Set(ids);

    return this.dependencies.modelStore.records.filter(
      (model) => identifiers.has(model.recordId),
    );
  }

  public async findCollection(
    query: CollectionQuery,
  ): Promise<PaginatedResult<TestModel, CollectionQuery["pagination"]>> {
    const { pagination } = query;
    const offset =
      (pagination.page - 1) * pagination.pageSize;
    const records =
      this.dependencies.modelStore.records.slice(
        offset,
        offset + pagination.pageSize + 1,
      );

    return {
      items: records.slice(0, pagination.pageSize),
      pageInfo: {
        type: "page",
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasNextPage: records.length > pagination.pageSize,
      },
    };
  }

  public async update(
    id: number,
    input: UpdateTestModelInput,
  ): Promise<TestModel | null> {
    const model = this.dependencies.modelStore.records.find(
      (candidate) => candidate.recordId === id,
    );

    if (model === undefined) {
      return null;
    }

    Object.assign(model, input);

    return model;
  }

  public async delete(id: number): Promise<TestModel | null> {
    const index = this.dependencies.modelStore.records.findIndex(
      (model) => model.recordId === id,
    );

    if (index === -1) {
      return null;
    }

    return (
      this.dependencies.modelStore.records.splice(index, 1)[0]
      ?? null
    );
  }
}

const createInputSchema = z.object({
  value: z.string(),
});
const identifierInputSchema = z.object({
  recordId: z.number().int(),
});
const updateInputSchema = identifierInputSchema.extend({
  value: z.string().optional(),
});
const outputSchema = z.object({
  recordId: z.number().int(),
  value: z.string(),
});
const modelIdKey = "recordId" satisfies keyof TestModel;

const createModelAction = defineModelCreateAction(
  "testModel",
  TestModelRepository,
  createInputSchema,
  outputSchema,
);
const getModelAction = defineModelGetAction(
  "testModel",
  TestModelRepository,
  modelIdKey,
  identifierInputSchema,
  outputSchema,
);
const getManyModelAction = defineModelGetManyAction(
  "testModel",
  TestModelRepository,
  z.object({ ids: z.array(identifierInputSchema.shape.recordId) }),
  outputSchema,
);
const deleteModelAction = defineModelDeleteAction(
  "testModel",
  TestModelRepository,
  modelIdKey,
  identifierInputSchema,
  outputSchema,
);
const updateModelAction = defineModelUpdateAction(
  "testModel",
  TestModelRepository,
  modelIdKey,
  updateInputSchema,
  outputSchema,
);
const listModelAction = defineModelListAction(
  "testModel",
  TestModelRepository,
  outputSchema,
);
const lookupModelAction = defineModelLookupAction(
  "testModel",
  TestModelRepository,
  outputSchema,
);

// @ts-expect-error The identifier key must exist in both model schemas.
defineModelGetAction("testModel", TestModelRepository, "missingId", identifierInputSchema, outputSchema);

describe("model action helpers", () => {
  it("defines conventional names and contracts", () => {
    expect(createModelAction.name).toBe("testModel.create");
    expect(getModelAction.name).toBe("testModel.get");
    expect(getManyModelAction.name).toBe("testModel.getMany");
    expect(deleteModelAction.name).toBe("testModel.delete");
    expect(updateModelAction.name).toBe("testModel.update");
    expect(listModelAction.name).toBe("testModel.list");
    expect(lookupModelAction.name).toBe("testModel.lookup");
    expect(createModelAction.description).toBe(
      "Create a testModel.",
    );
    expect(getModelAction.description).toBe(
      "Get a testModel by id.",
    );
    expect(getManyModelAction.description).toBe(
      "Get multiple testModel models by id.",
    );
    expect(deleteModelAction.description).toBe(
      "Delete a testModel by id.",
    );
    expect(updateModelAction.description).toBe(
      "Update a testModel by id.",
    );
    expect(lookupModelAction.description).toBe(
      "Look up testModel relation candidates.",
    );
    expect(listModelAction.description).toBe(
      "List testModel models.",
    );
    expect(createModelAction.inputSchema).toBe(
      createInputSchema,
    );
    expect(getModelAction.inputSchema).toBe(
      identifierInputSchema,
    );
    expect(deleteModelAction.inputSchema).toBe(
      identifierInputSchema,
    );
    expect(updateModelAction.inputSchema).toBe(
      updateInputSchema,
    );
  });

  it("lists numbered model pages", async () => {
    const app = new App({});
    const modelStore: ModelStore = {
      records: [
        { recordId: 1, value: "one" },
        { recordId: 2, value: "two" },
        { recordId: 3, value: "three" },
      ],
    };

    app.container.registerValue("modelStore", modelStore);

    const firstPage = await app.get(listModelAction).run({
      pagination: {
        type: "page",
        page: 1,
        pageSize: 2,
      },
    });

    expect(firstPage.items.map((model) => model.value))
      .toEqual(["one", "two"]);
    expect(firstPage.pageInfo).toEqual({
      type: "page",
      page: 1,
      pageSize: 2,
      hasNextPage: true,
    });

    const secondPage = await app.get(listModelAction).run({
      pagination: {
        type: "page",
        page: 2,
        pageSize: 2,
      },
    });

    expect(secondPage.items.map((model) => model.value))
      .toEqual(["three"]);
    expect(secondPage.pageInfo).toEqual({
      type: "page",
      page: 2,
      pageSize: 2,
      hasNextPage: false,
    });

    await app.dispose();
  });

  it("creates, gets, updates and deletes models through the repository", async () => {
    const app = new App({});
    const modelStore: ModelStore = { records: [] };

    app.container.registerValue("modelStore", modelStore);

    const created = await app.get(createModelAction).run({
      value: "created",
    });
    const found = await app.get(getModelAction).run({
      recordId: created.recordId,
    });
    const updated = await app.get(updateModelAction).run({
      recordId: created.recordId,
      value: "updated",
    });
    const deleted = await app.get(deleteModelAction).run({
      recordId: created.recordId,
    });
    const missing = await app.get(getModelAction).run({
      recordId: created.recordId,
    });

    expectTypeOf(created).toEqualTypeOf<TestModel>();
    expect(found).toEqual(created);
    expect(updated).toEqual({ ...created, value: "updated" });
    expect(deleted).toEqual(updated);
    expect(missing).toBeNull();

    await app.dispose();
  });

  it("gets multiple models by id and omits missing identifiers", async () => {
    const app = new App({});
    const modelStore: ModelStore = {
      records: [
        { recordId: 1, value: "one" },
        { recordId: 2, value: "two" },
        { recordId: 3, value: "three" },
      ],
    };

    app.container.registerValue("modelStore", modelStore);

    const found = await app.get(getManyModelAction).run({
      ids: [3, 1, 404],
    });

    expectTypeOf(found).toEqualTypeOf<TestModel[]>();
    expect(found).toEqual([
      { recordId: 1, value: "one" },
      { recordId: 3, value: "three" },
    ]);

    await app.dispose();
  });
});
