import {
  Command,
  CommanderError,
  Option,
} from "commander";
import {
  type input,
  type output,
  prettifyError,
  ZodError,
  type ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import {
  type App,
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
} from "../app/index.js";
import type {
  DependencyContainer,
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import type { CliErrorRepresentation } from "../errors/index.js";
import { runMiddlewarePipeline } from "../middleware/index.js";
import {
  observerDependency,
  type Observer,
} from "../observability/index.js";
import type { CliInputBinding } from "./bindings.js";
import type {
  CliController,
  CliObjectSchema,
} from "./controller.js";

export type CliOutputFormat = "pretty" | "json";

export interface CliCommandManagerOptions {
  name?: string;
  version?: string;
  writeOutput?: (value: string) => void;
  writeError?: (value: string) => void;
}

class CliInputError extends Error {
  public constructor(public readonly cause: ZodError) {
    super("The command input is invalid.", { cause });
  }
}

class CliHandledError extends Error {
  public constructor(
    public readonly representation: CliErrorRepresentation,
  ) {
    super(representation.message);
  }
}

interface RegisteredFieldBinding {
  field: string;
  binding: CliInputBinding;
  optionAttribute?: string;
}

/**
 * Registers CLI controllers and executes commands without owning process exit.
 */
export class CliCommandManager<Config> {
  private readonly program: Command;
  private readonly controllers: AnyRegisteredCliController[] = [];
  private readonly writeOutput: (value: string) => void;
  private readonly writeError: (value: string) => void;

  public constructor(
    private readonly app: App<Config>,
    options: CliCommandManagerOptions = {},
  ) {
    this.writeOutput =
      options.writeOutput ?? ((value) => process.stdout.write(value));
    this.writeError =
      options.writeError ?? ((value) => process.stderr.write(value));
    this.program = this.configureCommand(new Command())
      .name(options.name ?? "do")
      .addOption(
        new Option(
          "--_format <format>",
          "Output format.",
        )
          .choices(["pretty", "json"])
          .default("pretty"),
      );

    if (options.version !== undefined) {
      this.program.version(options.version);
    }
  }

  /**
   * Adds one controller to the command tree.
   */
  public register<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    const ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    const ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: CliController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): this {
    this.controllers.push(controller as AnyRegisteredCliController);
    const command = this.addCommandPath(controller.command);
    const fieldBindings = this.configureInput(
      command,
      controller,
    );

    if (controller.description !== undefined) {
      command.description(controller.description);
    }

    command.action(async () => {
      const execution = await this.app.createExecutionScope();
      const observer = controller.observe
        ? this.resolveObserver(execution.container)
        : undefined;
      const operation = controller.command;
      setExecutionLogContext(execution.context, {
        operation,
        transport: "cli",
      });
      const startedAt = performance.now();
      let outcome: "failure" | "success" = "success";
      let executionError: unknown;

      await this.app.runInObservationContext(observer, async () => {
        observer?.record(executionStartedObservation, {
          operation,
          transport: "cli",
        });

        try {
          const rawInput = this.readInput(command, fieldBindings);
          let input: output<ControllerInputSchema>;

          try {
            input = await parseSchema(
              controller.inputSchema,
              rawInput,
              controller.validation.input,
            );
          } catch (error: unknown) {
            if (error instanceof ZodError) {
              throw new CliInputError(error);
            }

            throw error;
          }

          const parsedResult = await runMiddlewarePipeline(
            controller.middleware,
            { controller, input, execution },
            execution.container,
            async () => {
              const dependencies = execution.container.resolveDependencies(
                controller.dependencies,
              );
              const result = controller.source === "standalone"
                ? await controller.handler({
                    input,
                    deps: dependencies,
                    execution,
                  })
                : await this.runActionController(
                    controller,
                    input,
                    dependencies,
                    execution,
                  );

              return controller.outputSchema === undefined
                ? result
                : parseSchema(controller.outputSchema, result, controller.validation.output);
            },
          );
          const format =
            command.optsWithGlobals<{ _format: CliOutputFormat }>()
              ._format;

          this.printResult(parsedResult, format);
        } catch (error: unknown) {
          outcome = "failure";
          executionError = error;
          // Input errors retain Commander's dedicated usage-oriented rendering.
          if (error instanceof CliInputError) {
            throw error;
          }

          throw new CliHandledError(
            execution.errorHandler.handleCli(error, {
              executionId: execution.id,
            }),
          );
        } finally {
          observer?.record(
            executionCompletedObservation,
            {
              operation,
              transport: "cli",
              ...getExecutionObservationContext(execution.context),
              ...(executionError === undefined
                ? {}
                : getExecutionObservationError(executionError)),
            },
            {
              outcome,
              durationMs: performance.now() - startedAt,
            },
          );
          await execution.dispose(outcome);
        }
      });
    });

    return this;
  }

  private resolveObserver(
    container: DependencyContainer<Config>,
  ): Observer | undefined {
    return container.hasRegistration("observer")
      ? container.resolve(observerDependency)
      : undefined;
  }

  /**
   * Parses user arguments and returns a process-compatible exit code.
   */
  public async run(arguments_: readonly string[]): Promise<number> {
    try {
      if (this.app.state === "composing") {
        this.prepare(arguments_);

        // Help and version only inspect declarative metadata and must not
        // initialize application infrastructure.
        if (!isInformationalInvocation(arguments_)) {
          await this.app.start();
        }
      }

      // An empty invocation shows the discoverable command catalog.
      const normalizedArguments =
        arguments_.length === 0 ? ["--help"] : [...arguments_];

      await this.program.parseAsync(normalizedArguments, {
        from: "user",
      });

      return 0;
    } catch (error: unknown) {
      if (error instanceof CommanderError) {
        if (
          error.code === "commander.helpDisplayed"
          || error.code === "commander.version"
        ) {
          return 0;
        }

        return 2;
      }

      if (error instanceof CliInputError) {
        this.writeError(
          `Invalid command input:\n${prettifyError(error.cause)}\n`,
        );

        return 2;
      }

      if (error instanceof CliHandledError) {
        this.writeError(`${error.representation.message}\n`);

        return error.representation.exitCode;
      }

      // Errors outside command execution cannot use an execution-scoped
      // handler and retain a minimal defensive fallback.
      this.writeError("An unexpected CLI error occurred.\n");

      return 1;
    }
  }

  /** Resolves controller metadata before application bootstrap begins. */
  public prepare(arguments_: readonly string[]): void {
    const controller = this.resolveController(arguments_);

    this.app.prepareBootPlan(
      controller?.prepareWorkloads?.(arguments_)
        ?? controller?.workloads
        ?? [],
      controller?.runningMode ?? "standard",
      controller?.runtime ?? "command",
    );
  }

  private resolveController(
    arguments_: readonly string[],
  ): AnyRegisteredCliController | undefined {
    const commandArguments = removeGlobalOptions(arguments_);

    return this.controllers
      .filter((controller) => {
        const segments = controller.command.split(" ");

        return segments.every(
          (segment, index) => commandArguments[index] === segment,
        );
      })
      .sort((left, right) =>
        right.command.split(" ").length - left.command.split(" ").length
      )[0];
  }

  private addCommandPath(path: string): Command {
    const segments = path.split(" ");
    const commandName = segments.pop();

    if (commandName === undefined) {
      throw new TypeError("A CLI command path cannot be empty.");
    }

    let parent = this.program;

    for (const segment of segments) {
      const existing = parent.commands.find(
        (command) => command.name() === segment,
      );

      if (existing !== undefined) {
        parent = existing;
        continue;
      }

      const group = this.configureCommand(
        new Command(segment),
      );

      parent.addCommand(group);
      parent = group;
    }

    if (
      parent.commands.some(
        (command) => command.name() === commandName,
      )
    ) {
      throw new Error(`CLI command "${path}" is already registered.`);
    }

    const command = this.configureCommand(
      new Command(commandName),
    );

    parent.addCommand(command);

    return command;
  }

  private configureInput<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    command: Command,
    controller: CliController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): RegisteredFieldBinding[] {
    const fields = Object.entries(
      controller.inputSchema.shape,
    ) as [string, ZodType][];
    const registered = fields.map(([field, schema]) => {
      if (field === "_format") {
        throw new Error(
          'The CLI input field "_format" is reserved.',
        );
      }

      const binding =
        controller.bindings[field] ?? { kind: "option" };

      return {
        field,
        binding,
        schema,
      };
    });
    const parameters = registered
      .filter(
        (item) => item.binding.kind === "parameter",
      )
      .sort((left, right) => {
        const leftIndex =
          left.binding.kind === "parameter"
            ? left.binding.index
            : 0;
        const rightIndex =
          right.binding.kind === "parameter"
            ? right.binding.index
            : 0;

        return leftIndex - rightIndex;
      });

    parameters.forEach((item, expectedIndex) => {
      if (
        item.binding.kind !== "parameter"
        || item.binding.index !== expectedIndex
      ) {
        throw new Error(
          "CLI positional parameter indexes must be unique and contiguous.",
        );
      }

      command.argument(
        item.schema.isOptional()
          ? `[${item.field}]`
          : `<${item.field}>`,
        item.schema.description,
      );
    });

    return registered.map(({ field, binding, schema }) => {
      if (binding.kind === "parameter") {
        return { field, binding };
      }

      const optionName = binding.name ?? field;

      assertOptionName(optionName);

      const cliOption = new Option(
        `--${optionName} <${field}>`,
        schema.description,
      );

      if (binding.repeatable === true) {
        cliOption.argParser((value: string, previous: string[] = []) => [
          ...previous,
          value,
        ]);
      }

      if (!schema.isOptional()) {
        cliOption.makeOptionMandatory();
      }

      command.addOption(cliOption);

      return {
        field,
        binding,
        optionAttribute: cliOption.attributeName(),
      };
    });
  }

  private async runActionController<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: Extract<
      CliController<
        ActionInputSchema,
        ActionOutputSchema,
        ActionDependencies,
        ControllerInputSchema,
        ControllerOutputSchema,
        ControllerDependencies
      >,
      { source: "action" }
    >,
    input_: output<ControllerInputSchema>,
    dependencies: ResolvedDependencies<ControllerDependencies>,
    execution: Awaited<ReturnType<App<Config>["createExecutionScope"]>>,
  ): Promise<unknown> {
    const action = execution.get(controller.action);

    return controller.handler === undefined
      ? action.run(input_ as input<ActionInputSchema>)
      : controller.handler({
          action,
          input: input_,
          deps: dependencies,
          execution,
        });
  }

  private readInput(
    command: Command,
    bindings: RegisteredFieldBinding[],
  ): Record<string, unknown> {
    const options = command.opts<Record<string, unknown>>();

    return Object.fromEntries(
      bindings.flatMap((registered) => {
        const value =
          registered.binding.kind === "parameter"
            ? command.processedArgs[registered.binding.index]
            : options[registered.optionAttribute ?? registered.field];

        return value === undefined
          ? []
          : [[registered.field, value]];
      }),
    );
  }

  private printResult(
    result: unknown,
    format: CliOutputFormat,
  ): void {
    const serialized =
      format === "pretty"
        ? JSON.stringify(result, null, 2)
        : JSON.stringify(result);

    if (serialized !== undefined) {
      this.writeOutput(`${serialized}\n`);
    }
  }

  private configureCommand(command: Command): Command {
    return command
      .showHelpAfterError()
      .exitOverride()
      .configureOutput({
        writeOut: this.writeOutput,
        writeErr: this.writeError,
      });
  }
}

/** Detects invocations that Commander resolves without executing a handler. */
function isInformationalInvocation(arguments_: readonly string[]): boolean {
  return arguments_.length === 0
    || arguments_.some((argument) =>
      argument === "--help"
      || argument === "-h"
      || argument === "--version"
      || argument === "-V"
    );
}

type AnyRegisteredCliController = CliController<any, any, any, any, any, any>;

/** Removes the root output option so it does not affect command selection. */
function removeGlobalOptions(arguments_: readonly string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--_format") {
      index += 1;
      continue;
    }

    if (argument?.startsWith("--_format=")) {
      continue;
    }

    if (argument !== undefined) {
      result.push(argument);
    }
  }

  return result;
}

function assertOptionName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError(`Invalid CLI option name "${name}".`);
  }
}
