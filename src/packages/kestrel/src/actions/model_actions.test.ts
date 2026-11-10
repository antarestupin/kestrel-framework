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
  RepositoryReturningOptions,
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
  requests?: Array<{ method: string; args: readonly unknown[] }>;
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

  public create(
    input: CreateTestModelInput,
    options: RepositoryReturningOptions<true>,
  ): Promise<TestModel>;
  public create(
    input: CreateTestModelInput,
    options?: RepositoryReturningOptions<false>,
  ): Promise<void>;
  public async create(
    input: CreateTestModelInput,
    options: RepositoryReturningOptions<boolean> = {},
  ): Promise<TestModel | void> {
    this.dependencies.modelStore.requests?.push({ method: "create", args: [input, options] });
    const model = {
      recordId: this.dependencies.modelStore.records.length + 1,
      ...input,
    };

    this.dependencies.modelStore.records.push(model);

    // Match the real repository: writes return rows only when RETURNING is explicitly requested.
    return options.returning === true ? { ...model } : undefined;
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
    this.dependencies.modelStore.requests?.push({ method: "findCollection", args: [query] });
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

  public update(
    id: number,
    input: UpdateTestModelInput,
    options: RepositoryReturningOptions<true>,
  ): Promise<TestModel | null>;
  public update(
    id: number,
    input: UpdateTestModelInput,
    options?: RepositoryReturningOptions<false>,
  ): Promise<void>;
  public async update(
    id: number,
    input: UpdateTestModelInput,
    options: RepositoryReturningOptions<boolean> = {},
  ): Promise<TestModel | null | void> {
    this.dependencies.modelStore.requests?.push({ method: "update", args: [id, input, options] });
    const model = this.dependencies.modelStore.records.find(
      (candidate) => candidate.recordId === id,
    );

    if (model === undefined) {
      return options.returning === true ? null : undefined;
    }

    Object.assign(model, input);

    return options.returning === true ? { ...model } : undefined;
  }

  public delete(id: number, options: RepositoryReturningOptions<true>): Promise<TestModel | null>;
  public delete(id: number, options?: RepositoryReturningOptions<false>): Promise<void>;
  public async delete(
    id: number,
    options: RepositoryReturningOptions<boolean> = {},
  ): Promise<TestModel | null | void> {
    this.dependencies.modelStore.requests?.push({ method: "delete", args: [id, options] });
    const index = this.dependencies.modelStore.records.findIndex(
      (model) => model.recordId === id,
    );

    if (index === -1) {
      return options.returning === true ? null : undefined;
    }

    const deleted = (
      this.dependencies.modelStore.records.splice(index, 1)[0]
      ?? null
    );

    return options.returning === true ? deleted : undefined;
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

    try {
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
    } finally {
      await app.dispose();
    }

  });

  it("creates, gets, updates and deletes models through the repository", async () => {
    const app = new App({});
    const modelStore: ModelStore = { records: [], requests: [] };

    app.container.registerValue("modelStore", modelStore);

    try {
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
      // Returning a model is part of each write Action's public contract; the repository
      // must receive both the explicit return policy and update values without the identifier.
      expect(modelStore.requests).toEqual([
        { method: "create", args: [{ value: "created" }, { returning: true }] },
        { method: "update", args: [created.recordId, { value: "updated" }, { returning: true }] },
        { method: "delete", args: [created.recordId, { returning: true }] },
      ]);
    } finally {
      await app.dispose();
    }

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

    try {
      const found = await app.get(getManyModelAction).run({
        ids: [3, 1, 404],
      });

      expectTypeOf(found).toEqualTypeOf<TestModel[]>();
      expect(found).toEqual([
        { recordId: 1, value: "one" },
        { recordId: 3, value: "three" },
      ]);
    } finally {
      await app.dispose();
    }

  });

  for (const operation of ["get", "update", "delete"] as const) {
    it(`returns null from ${operation} without changing another model when the identifier is absent`, async () => {
      const app = new App({});
      const modelStore: ModelStore = { records: [{ recordId: 1, value: "unchanged" }] };
      app.container.registerValue("modelStore", modelStore);
      try {
        const result = operation === "get" ? await app.get(getModelAction).run({ recordId: 404 })
          : operation === "update" ? await app.get(updateModelAction).run({ recordId: 404, value: "wrong" })
            : await app.get(deleteModelAction).run({ recordId: 404 });
        expect(result).toBeNull();
        expect(modelStore.records).toEqual([{ recordId: 1, value: "unchanged" }]);
      } finally {
        await app.dispose();
      }
    });
  }

  for (const operation of ["list", "lookup"] as const) {
    it(`forwards the parsed collection query through ${operation} and validates the paginated response`, async () => {
      const app = new App({});
      const modelStore: ModelStore = {
        records: [{ recordId: 1, value: "one" }, { recordId: 2, value: "two" }],
        requests: [],
      };
      app.container.registerValue("modelStore", modelStore);
      try {
        const action = operation === "list" ? listModelAction : lookupModelAction;
        const pagination = { type: "page" as const, page: 2, pageSize: 1 };
        const search = { term: "two" };
        const filters = [{ field: "value", operator: "contains" as const, value: "o" }];
        const sort = [{ field: "recordId", direction: "desc" as const }];
        // Transport-shaped JSON must be parsed before the model helper forwards it to storage.
        expect(await app.get(action).run({
          pagination,
          search: JSON.stringify(search),
          filters: JSON.stringify(filters),
          sort: JSON.stringify(sort),
        })).toEqual({
          items: [{ recordId: 2, value: "two" }],
          pageInfo: { ...pagination, hasNextPage: false },
        });
        expect(modelStore.requests).toEqual([
          { method: "findCollection", args: [{ pagination, search, filters, sort }] },
        ]);
      } finally {
        await app.dispose();
      }
    });
  }

  it("selects by a parsed identifier and omits it from the normalized update values", async () => {
    const app = new App({});
    const modelStore: ModelStore = { records: [{ recordId: 1, value: "before" }], requests: [] };
    app.container.registerValue("modelStore", modelStore);
    const normalizedUpdate = defineModelUpdateAction(
      "normalizedModel",
      TestModelRepository,
      modelIdKey,
      z.object({ recordId: z.coerce.number<string>().int(), value: z.string().trim() }),
      outputSchema,
    );
    try {
      expect(await app.get(normalizedUpdate).run({ recordId: "1", value: "  updated  " })).toEqual({ recordId: 1, value: "updated" });
      expect(modelStore.requests).toEqual([
        { method: "update", args: [1, { value: "updated" }, { returning: true }] },
      ]);
    } finally {
      await app.dispose();
    }
  });
});
