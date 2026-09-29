import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  z,
  type output,
  ZodError,
  type ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import {
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
  type RuntimeApp,
} from "../app/index.js";
import type {
  DependencyContainer,
  DependencyDeclarations,
} from "../di/index.js";
import {
  getHttpErrorName,
  type HttpErrorRepresentation,
} from "../errors/index.js";
import {
  observerDependency,
  type Observer,
} from "../observability/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import {
  extractHttpPathParameters,
  type HttpInputBinding,
  resolveHttpInputBinding,
} from "./bindings.js";
import type {
  HttpController,
  HttpObjectSchema,
} from "./controller.js";
import { executeHttpController } from "./controller_executor.js";

const executionIdSchema = z.uuid();

interface HttpErrorBody {
  statusCode: number;
  error: string;
  message: string;
  issues?: ZodError["issues"];
}

export interface HttpControllerManagerOptions {
  /** Omits execution observations while preserving normal request handling. */
  observe?: boolean;
  /** Enables or suppresses execution-context logging for managed requests. */
  executionLog?: boolean;
  /** Exposes the execution correlation identifier on every managed response. */
  executionIdHeader?: string;
}

/**
 * Registers standalone and action-backed controllers on a Fastify instance.
 */
export class HttpControllerManager<Config> {
  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly server: FastifyInstance,
    private readonly options: HttpControllerManagerOptions = {},
  ) {}

  /**
   * Adds one controller to the Fastify route catalog.
   */
  public register<
    ActionInputSchema extends HttpObjectSchema,
    ActionOutputSchema extends ZodType,
    const ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends HttpObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    const ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: HttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): this {
    this.assertPathBindings(controller);

    this.server.route({
      ...controller.fastify,
      method: controller.route.method,
      url: controller.route.url,
      handler: async (request, reply) =>
        this.handle(controller, request, reply),
    });

    return this;
  }

  private async handle<
    ActionInputSchema extends HttpObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends HttpObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: HttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const requestedExecutionId = this.options.executionIdHeader === undefined
      ? undefined
      : request.headers[this.options.executionIdHeader.toLowerCase()];
    const parsedExecutionId = executionIdSchema.safeParse(
      requestedExecutionId,
    );
    // A caller can establish correlation before receiving the response. Invalid
    // or absent values fall back to the application's collision-safe UUID.
    const execution = await this.app.createExecutionScope(
      parsedExecutionId.success ? parsedExecutionId.data : undefined,
    );

    if (
      this.options.executionLog !== undefined
      && execution.container.hasRegistration(
        setExecutionLogEnabledDependency.id,
      )
    ) {
      execution.container.resolve(setExecutionLogEnabledDependency)(
        this.options.executionLog,
      );
    }

    if (this.options.executionIdHeader !== undefined) {
      reply.header(this.options.executionIdHeader, execution.id);
    }

    const observer = this.resolveObserver(execution.container);
    const operation = `${controller.route.method} ${controller.route.url}`;
    setExecutionLogContext(execution.context, {
      operation,
      transport: "http",
      workload: "http",
    });
    const startedAt = performance.now();
    let outcome: "failure" | "success" = "success";
    let executionError: unknown;

    return this.app.runInObservationContext(observer, async () => {
      observer?.record(executionStartedObservation, {
        operation,
        transport: "http",
      });

      try {
        const rawInput = this.readInput(controller, request);
        let parsedInput: output<ControllerInputSchema>;

        try {
          parsedInput = await parseSchema(
            controller.inputSchema,
            rawInput,
            controller.validation.input,
          );
        } catch (error: unknown) {
          if (error instanceof ZodError) {
            return this.sendError(reply, {
              statusCode: 400,
              error: "Bad Request",
              message: "The request input is invalid.",
              issues: error.issues,
            });
          }

          throw error;
        }

        const parsedResult = await executeHttpController(
          controller,
          parsedInput,
          { request, reply, execution },
        );

        // A custom handler can take full ownership by sending a reply itself.
        if (reply.sent) {
          return reply;
        }

        if (parsedResult === null) {
          return this.sendError(reply, {
            statusCode: 404,
            error: "Not Found",
            message: "The requested resource was not found.",
          });
        }

        return reply
          .code(controller.successStatusCode)
          .send(parsedResult);
      } catch (error: unknown) {
        outcome = "failure";
        executionError = error;
        const representation = execution.errorHandler.handleHttp(error, {
          executionId: execution.id,
        });

        // A failing custom handler may already have taken ownership of the reply.
        return reply.sent
          ? reply
          : this.sendHandledError(reply, representation);
      } finally {
        observer?.record(
          executionCompletedObservation,
          {
            operation,
            transport: "http",
            statusCode: reply.statusCode,
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
  }

  private resolveObserver(
    container: DependencyContainer<Config>,
  ): Observer | undefined {
    return this.options.observe === false
      || !container.hasRegistration("observer")
      ? undefined
      : container.resolve(observerDependency);
  }

  private readInput<
    ActionInputSchema extends HttpObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends HttpObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: HttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
    request: FastifyRequest,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.keys(controller.inputSchema.shape).map((field) => {
        const binding = resolveHttpInputBinding(
          controller.route,
          field,
          controller.bindings[field],
        );
        const source = getRequestSource(request, binding);
        const sourceName = binding.name ?? field;

        return [field, source[sourceName]];
      }),
    );
  }

  private assertPathBindings<
    ActionInputSchema extends HttpObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends HttpObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: HttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): void {
    const pathParameters = extractHttpPathParameters(controller.route.url);

    for (const [field, binding] of Object.entries(controller.bindings)) {
      if (binding?.kind !== "path") {
        continue;
      }

      const parameterName = binding.name ?? field;

      if (!pathParameters.has(parameterName)) {
        throw new Error(
          `HTTP path binding "${parameterName}" does not exist in route "${controller.route.url}".`,
        );
      }
    }
  }

  private sendError(
    reply: FastifyReply,
    body: HttpErrorBody,
  ): FastifyReply {
    return reply.code(body.statusCode).send(body);
  }

  private sendHandledError(
    reply: FastifyReply,
    representation: HttpErrorRepresentation,
  ): FastifyReply {
    if (representation.headers !== undefined) {
      reply.headers(representation.headers);
    }

    return reply.code(representation.statusCode).send({
      ...representation.extensions,
      statusCode: representation.statusCode,
      error: representation.error
        ?? getHttpErrorName(representation.statusCode),
      message: representation.message,
    });
  }
}

function getRequestSource(
  request: FastifyRequest,
  binding: HttpInputBinding,
): Record<string, unknown> {
  const source =
    binding.kind === "path"
      ? request.params
      : binding.kind === "query"
        ? request.query
        : request.body;

  return isRecord(source) ? source : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
