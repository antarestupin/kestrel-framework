import type { AnyScheduledTask } from "./task.js";
import type { CatalogTree } from "../utils/index.js";
import { isScheduledTask } from "../utils/index.js";
import type { CatalogDefinitionSource } from "../definitions/index.js";

/** Backward-compatible name for the source metadata shared by all catalogs. */
export type ScheduledTaskDefinitionSource = CatalogDefinitionSource;

export interface RegisteredScheduledTask {
  readonly task: AnyScheduledTask;
  readonly source: ScheduledTaskDefinitionSource;
  /** Declaration path retained for diagnostics and tooling navigation. */
  readonly path: readonly string[];
}

/** Collects application and provider definitions before runtime consumers start. */
export class ScheduledTaskRegistry {
  private readonly registrationsById = new Map<
    string,
    RegisteredScheduledTask
  >();

  /** Registers one definition and rejects ambiguous ownership immediately. */
  public register(
    task: AnyScheduledTask,
    source: ScheduledTaskDefinitionSource,
    path: readonly string[] = [task.id],
  ): this {
    const existing = this.registrationsById.get(task.id);

    if (existing !== undefined) {
      throw new TypeError(
        `Scheduled task ids must be unique: "${task.id}" is contributed by ${formatSource(existing.source)} and ${formatSource(source)}.`,
      );
    }

    const collidingPath = [...this.registrationsById.values()].find(
      (registration) => pathsCollide(registration.path, path),
    );

    if (collidingPath !== undefined) {
      throw new TypeError(
        `Scheduled task catalog path "${path.join(".")}" collides with "${collidingPath.path.join(".")}".`,
      );
    }

    this.registrationsById.set(task.id, { task, source, path: [...path] });
    return this;
  }

  /** Registers a definition collection in declaration order. */
  public registerMany(
    tasks: readonly AnyScheduledTask[],
    source: ScheduledTaskDefinitionSource,
  ): this {
    for (const task of tasks) {
      this.register(task, source);
    }

    return this;
  }

  /** Registers a nested application catalog while retaining every branch. */
  public registerCatalog(
    catalog: CatalogTree<AnyScheduledTask>,
    source: ScheduledTaskDefinitionSource,
    parentPath: readonly string[] = [],
  ): this {
    for (const [name, value] of Object.entries(catalog)) {
      const path = [...parentPath, name];

      if (isScheduledTask(value)) {
        this.register(value, source, path);
      } else {
        this.registerCatalog(value, source, path);
      }
    }

    return this;
  }

  /** Lists consolidated definitions in registration order. */
  public get tasks(): readonly AnyScheduledTask[] {
    return [...this.registrationsById.values()].map(({ task }) => task);
  }

  /** Lists definitions with provenance for diagnostics and Studio. */
  public get registrations(): readonly RegisteredScheduledTask[] {
    return [...this.registrationsById.values()];
  }

  /** Reconstructs the nested task view retained from declaration paths. */
  public get catalog(): CatalogTree<AnyScheduledTask> {
    const catalog: Record<string, AnyScheduledTask | CatalogTree<AnyScheduledTask>> = {};

    for (const { path, task } of this.registrationsById.values()) {
      let branch = catalog;

      for (const [index, part] of path.entries()) {
        if (index === path.length - 1) {
          branch[part] = task;
        } else {
          const child = branch[part] ??= {};
          branch = child as Record<
            string,
            AnyScheduledTask | CatalogTree<AnyScheduledTask>
          >;
        }
      }
    }

    return catalog;
  }
}

/** Detects equal paths and leaf-to-branch collisions. */
function pathsCollide(
  first: readonly string[],
  second: readonly string[],
): boolean {
  const sharedLength = Math.min(first.length, second.length);
  return first.slice(0, sharedLength).every(
    (part, index) => second[index] === part,
  );
}

function formatSource(source: ScheduledTaskDefinitionSource): string {
  return source.kind === "application"
    ? "the application catalog"
    : `provider "${source.provider}"`;
}
