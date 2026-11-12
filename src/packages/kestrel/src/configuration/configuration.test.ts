import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  configure,
  ConfigurationError,
  createConfigurationApi,
  defineConfigBase,
} from "./index.js";

const {
  defineConfig,
  envs,
  envVar,
  fromEnv,
  resolveConfig,
  resolveEnvironment,
} = createConfigurationApi({
  environments: ["development", "test", "preview", "production"],
  defaultEnvironment: "development",
});

if (false) {
  // @ts-expect-error Environment names are checked when config is declared.
  fromEnv({ local: "http://localhost" });

  // @ts-expect-error Grouped environment names use the same checks.
  envs(["development", "local"], "http://localhost");

  const requiredBase = defineConfigBase(z.object({ required: z.string() }));

  // @ts-expect-error Library-required values must be supplied by the app.
  configure(requiredBase, {});

  // @ts-expect-error Static base values are checked while config is declared.
  configure(requiredBase, { required: 42 });
}

describe("configuration", () => {
  it("completes and extends a library configuration base", () => {
    const base = defineConfigBase(z.object({
      endpoint: z.url(),
      retries: z.coerce.number().int().nonnegative().default(3),
      batchSize: z.coerce.number().int().positive().default(10),
    }));
    const contribution = configure(base, {
      endpoint: envVar("SERVICE_ENDPOINT"),
      retries: envVar("SERVICE_RETRIES", { fallback: "4" }),
      batchSize: envVar("SERVICE_BATCH_SIZE"),
      applicationLabel: "primary",
      alertThreshold: envVar(
        "SERVICE_ALERT_THRESHOLD",
        z.coerce.number().positive(),
      ),
    });
    const definition = defineConfig({ service: contribution });

    const config = resolveConfig(definition, {
      environment: "test",
      env: {
        SERVICE_ENDPOINT: "https://example.com",
        SERVICE_ALERT_THRESHOLD: "25",
      },
    });

    expect(config).toEqual({
      service: {
        endpoint: "https://example.com",
        retries: 4,
        batchSize: 10,
        applicationLabel: "primary",
        alertThreshold: 25,
      },
    });
    expectTypeOf(config.service.endpoint).toEqualTypeOf<string>();
    expectTypeOf(config.service.retries).toEqualTypeOf<number>();
    expectTypeOf(config.service.batchSize).toEqualTypeOf<number>();
    expectTypeOf(config.service.applicationLabel)
      .toEqualTypeOf<"primary">();
    expectTypeOf(config.service.alertThreshold).toEqualTypeOf<number>();
  });

  it("reports the contribution path when its base rejects a value", () => {
    const base = defineConfigBase(z.object({
      port: z.coerce.number().int().positive(),
    }));
    const definition = defineConfig({
      service: configure(base, { port: envVar("SERVICE_PORT") }),
    });

    expect(() => resolveConfig(definition, {
      environment: "test",
      env: { SERVICE_PORT: "invalid" },
    })).toThrowError(
      "Invalid configuration: service.port: Invalid input: expected number, received NaN",
    );
  });

  it("resolves static and nested dynamic values", () => {
    const definition = defineConfig({
      applicationName: "TestApp",
      http: {
        host: fromEnv({
          development: "localhost",
          test: "test.localhost",
          default: "example.com",
        }),
        port: envVar(
          "PORT",
          z.coerce.number().int().min(0).max(65_535),
        ),
      },
    });

    const config = resolveConfig(definition, {
      environment: "test",
      env: { PORT: "4242" },
    });

    expect(config).toEqual({
      applicationName: "TestApp",
      http: {
        host: "test.localhost",
        port: 4242,
      },
    });
    expectTypeOf(config.http.port).toEqualTypeOf<number>();
  });

  it("uses the default when the active environment has no dedicated value", () => {
    const definition = defineConfig({
      origin: fromEnv({
        development: "http://localhost",
        default: "https://example.com",
      }),
    });

    const config = resolveConfig(definition, {
      environment: "production",
      env: {},
    });

    expect(config.origin).toBe("https://example.com");
  });

  it("maps one value to several environments", () => {
    const definition = defineConfig({
      origin: fromEnv({
        ...envs(
          ["development", "test"],
          "http://localhost",
        ),
        default: "https://example.com",
      }),
    });

    const developmentConfig = resolveConfig(definition, {
      environment: "development",
      env: {},
    });
    const testConfig = resolveConfig(definition, {
      environment: "test",
      env: {},
    });

    expect(developmentConfig.origin).toBe("http://localhost");
    expect(testConfig.origin).toBe("http://localhost");
  });

  it("resolves a source selected by another source", () => {
    const definition = defineConfig({
      token: fromEnv({
        test: envVar("TEST_TOKEN", z.string().min(1)),
        default: "not-used-in-this-test",
      }),
    });

    const config = resolveConfig(definition, {
      environment: "test",
      env: { TEST_TOKEN: "secret" },
    });

    expect(config.token).toBe("secret");
    expectTypeOf(config.token).toEqualTypeOf<string>();
  });

  it("reads only variables owned by the supplied environment map", () => {
    const definition = defineConfig({
      name: envVar("toString"),
      endpoint: envVar("SERVICE_ENDPOINT", { fallback: "https://example.com" }),
      retries: envVar("SERVICE_RETRIES", z.coerce.number().int().default(3)),
    });
    const env: Record<string, string> = {};
    Object.setPrototypeOf(env, {
      SERVICE_ENDPOINT: "https://inherited.example.com",
      SERVICE_RETRIES: "9",
    });

    expect(resolveConfig(definition, { env })).toEqual({
      name: undefined,
      endpoint: "https://example.com",
      retries: 3,
    });
  });

  it("reports the variable and config path when validation fails", () => {
    const definition = defineConfig({
      http: {
        port: envVar("PORT", z.coerce.number().int().positive()),
      },
    });

    expect(() =>
      resolveConfig(definition, {
        environment: "development",
        env: { PORT: "invalid" },
      }),
    ).toThrowError(
      new ConfigurationError(
        'Invalid environment variable "PORT" at "http.port": Invalid input: expected number, received NaN',
      ),
    );
  });

  it("fails when no environment-specific or default value exists", () => {
    const definition = defineConfig({
      endpoint: fromEnv({ development: "http://localhost" }),
    });

    expect(() =>
      resolveConfig(definition, {
        environment: "preview",
        env: {},
      }),
    ).toThrowError(
      'No value is configured for environment "preview" at "endpoint".',
    );
  });
});

describe("conventional environment overrides", () => {
  const createConventionalApi = () => createConfigurationApi({
    environments: ["development", "test", "production"],
    defaultEnvironment: "development",
    environmentOverrides: {
      prefix: "APP_CONFIG",
    },
  });

  it.each([
    ["app_CONFIG", "Expected uppercase letters"],
    ["APP__CONFIG", "Double underscores are reserved"],
  ])("rejects malformed override prefix %s", (prefix, error) => {
    expect(() => createConfigurationApi({
      environments: ["test"],
      defaultEnvironment: "test",
      environmentOverrides: { prefix },
    })).toThrowError(error);
  });

  it("overrides configured values and omitted library defaults", () => {
    const { defineConfig, fromEnv, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      endpoint: z.url(),
      secret: z.string().min(8),
      retries: z.union([z.number(), z.string()])
        .pipe(z.coerce.number<string | number>().int().positive())
        .default(3),
      policy: z.object({
        label: z.string().min(1),
        enabled: z.boolean().default(false),
        maxAttempts: z.coerce.number().int().positive().default(2),
      }).default({ label: "standard", enabled: false, maxAttempts: 2 }),
    }));
    const definition = defineConfig({
      service: configure(base, {
        endpoint: fromEnv({
          test: "https://test.example.com",
          default: "https://example.com",
        }),
        // Deployment environments may defer a required value to the override.
        secret: fromEnv({ default: undefined }),
      }),
    });

    const config = resolveConfig(definition, {
      environment: "test",
      env: {
        APP_CONFIG__SERVICE__ENDPOINT: "https://override.example.com",
        APP_CONFIG__SERVICE__SECRET: "deployed-secret",
        APP_CONFIG__SERVICE__RETRIES: "7",
        APP_CONFIG__SERVICE__POLICY__ENABLED: "true",
        APP_CONFIG__SERVICE__POLICY__MAX_ATTEMPTS: "5",
      },
    });

    expect(config).toEqual({
      service: {
        endpoint: "https://override.example.com",
        secret: "deployed-secret",
        retries: 7,
        policy: { label: "standard", enabled: true, maxAttempts: 5 },
      },
    });
  });

  it("discovers conventional targets in the contribution selected for the active environment", () => {
    const { defineConfig, fromEnv, resolveConfig } = createConventionalApi();
    const primary = defineConfigBase(z.object({
      enabled: z.boolean().default(false),
      retries: z.number().default(3),
    }));
    const alternative = defineConfigBase(z.object({ region: z.string().default("eu") }));
    const definition = defineConfig({
      service: fromEnv({
        test: configure(primary, {}),
        default: configure(alternative, {}),
      }),
    });

    expect(resolveConfig(definition, {
      environment: "test",
      env: { APP_CONFIG__SERVICE__ENABLED: "true" },
    }).service).toEqual({ enabled: true, retries: 3 });
    expect(() => resolveConfig(definition, {
      environment: "production",
      env: { APP_CONFIG__SERVICE__ENABLED: "true" },
    })).toThrowError('Unknown conventional environment variable "APP_CONFIG__SERVICE__ENABLED".');
  });

  it("ignores inherited conventional overrides even when they would create an optional object", () => {
    const { resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      limit: z.number().default(3),
      queue: z.object({ limit: z.number() }).optional(),
    }));
    const env = Object.create({
      APP_CONFIG__SERVICE__LIMIT: "11",
      APP_CONFIG__SERVICE__QUEUE__LIMIT: "12",
    }) as Record<string, string>;

    expect(resolveConfig({ service: configure(base, {}) }, { env }).service)
      .toEqual({ limit: 3 });
  });

  it("materializes an optional object using the override and its leaf defaults", () => {
    const { resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      queue: z.object({
        limit: z.number().positive(),
        enabled: z.boolean().default(true),
      }).optional(),
    }));
    const config = resolveConfig({ service: configure(base, {}) }, {
      env: { APP_CONFIG__SERVICE__QUEUE__LIMIT: "7" },
    });

    expect(config.service.queue).toEqual({ limit: 7, enabled: true });
  });

  it("preserves nested default siblings across independent resolutions", () => {
    const { resolveConfig } = createConventionalApi();
    const initial = { queue: { limit: 3, enabled: true }, label: "standard" };
    const base = defineConfigBase(z.object({
      policy: z.object({
        queue: z.object({ limit: z.number().positive(), enabled: z.boolean() }),
        label: z.string(),
      }).default(initial),
    }));
    const definition = { service: configure(base, {}) };
    const config = resolveConfig(definition, {
      env: { APP_CONFIG__SERVICE__POLICY__QUEUE__LIMIT: "7" },
    });

    expect(config.service.policy).toEqual({
      queue: { limit: 7, enabled: true },
      label: "standard",
    });
    expect(initial.queue.limit).toBe(3);
    expect(resolveConfig(definition, { env: {} }).service.policy).toEqual(initial);
  });

  it("keeps prototype keys out of the conventional override catalog", () => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const sentinel = "configurationOverridePrototypeRegression";
    const base = defineConfigBase(z.object({
      ["__proto__"]: z.object({ [sentinel]: z.string().optional() }).optional(),
    }));
    const definition = defineConfig({ service: configure(base, {}) });
    const name = "APP_CONFIG__SERVICE____PROTO____CONFIGURATION_OVERRIDE_PROTOTYPE_REGRESSION";

    let failure: unknown;
    try {
      try {
        resolveConfig(definition, { env: { [name]: "injected" } });
      } catch (error: unknown) {
        failure = error;
      }
      expect(Object.hasOwn(Object.prototype, sentinel)).toBe(false);
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure).toMatchObject({ message: `Unknown conventional environment variable "${name}".` });
    } finally {
      // Running this regression against the old implementation can pollute the prototype.
      Reflect.deleteProperty(Object.prototype, sentinel);
    }
  });

  it("keeps an explicit envVar binding authoritative", () => {
    const { defineConfig, envVar, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      port: z.coerce.number().int().positive(),
      exactPort: z.coerce.number().int().positive().default(3_333),
    }));
    const definition = defineConfig({
      http: configure(base, {
        port: envVar("PORT"),
        exactPort: envVar("APP_CONFIG__HTTP__EXACT_PORT"),
      }),
    });

    expect(resolveConfig(definition, {
      env: {
        PORT: "4242",
        APP_CONFIG__HTTP__EXACT_PORT: "4141",
      },
    }).http).toEqual({ port: 4_242, exactPort: 4_141 });

    expect(() => resolveConfig(definition, {
      env: {
        PORT: "4242",
        APP_CONFIG__HTTP__PORT: "4343",
      },
    })).toThrowError(
      'Conventional environment variable "APP_CONFIG__HTTP__PORT" cannot override "http.port" because that path explicitly uses envVar("PORT").',
    );
  });

  it("rejects unknown variables under the reserved prefix", () => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      port: z.coerce.number().int().positive().default(3_333),
    }));
    const definition = defineConfig({ http: configure(base, {}) });

    expect(() => resolveConfig(definition, {
      env: { APP_CONFIG__HTPP__PORT: "4242" },
    })).toThrowError(
      'Unknown conventional environment variable "APP_CONFIG__HTPP__PORT".',
    );
  });

  it.each(["invalid", "-1"])("reports the variable and config path for invalid override %s", (raw) => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      port: z.coerce.number().int().positive().default(3_333),
    }));
    const definition = defineConfig({ http: configure(base, {}) });

    expect(() => resolveConfig(definition, {
      env: { APP_CONFIG__HTTP__PORT: raw },
    })).toThrowError(
      'Invalid conventional environment variable "APP_CONFIG__HTTP__PORT" at "http.port"',
    );
  });

  it("reports a schema key that cannot be represented in a conventional variable", () => {
    const { resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({ "retry-limit": z.number().default(3) }));

    expect(() => resolveConfig({ service: configure(base, {}) }, { env: {} }))
      .toThrowError('Configuration path "service.retry-limit" cannot be converted');
  });

  it("rejects names that collapse two schema paths", () => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      retryLimit: z.number().default(1),
      retry_limit: z.number().default(2),
    }));
    const definition = defineConfig({ service: configure(base, {}) });

    expect(() => resolveConfig(definition, { env: {} })).toThrowError(
      'Conventional environment variable "APP_CONFIG__SERVICE__RETRY_LIMIT" maps to both "service.retryLimit" and "service.retry_limit".',
    );
  });

  it("does not expose arrays or polymorphic objects implicitly", () => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      origins: z.array(z.url()).default([]),
      backend: z.discriminatedUnion("strategy", [
        z.object({ strategy: z.literal("reject") }),
        z.object({
          strategy: z.literal("fallback"),
          limit: z.number().positive(),
        }),
      ]).default({ strategy: "reject" }),
    }));
    const definition = defineConfig({ service: configure(base, {}) });

    expect(() => resolveConfig(definition, {
      env: { APP_CONFIG__SERVICE__ORIGINS: "[]" },
    })).toThrowError(
      'Unknown conventional environment variable "APP_CONFIG__SERVICE__ORIGINS".',
    );
  });

  it("resolves explicit bindings inside an array of configuration contributions", () => {
    const { envVar, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      limit: z.coerce.number().int().positive(),
    }));
    // Explicit names remain usable even when an array has no conventional path.
    const definition = { queues: [configure(base, { limit: envVar("APP_CONFIG__QUEUE_LIMIT") })] };
    const env = { APP_CONFIG__QUEUE_LIMIT: "7" };

    expect(resolveConfig(definition, { env }).queues).toEqual([{ limit: 7 }]);
    expect(() => resolveConfig(definition, {
      env: { ...env, APP_CONFIG__QUEUES__0__LIMIT: "9" },
    })).toThrowError('Unknown conventional environment variable "APP_CONFIG__QUEUES__0__LIMIT".');
  });
});

describe("environment resolution", () => {
  it("uses the configured default and accepts another declared environment", () => {
    expect(resolveEnvironment()).toBe("development");
    expect(resolveEnvironment("test")).toBe("test");
  });

  it("rejects unsupported environments", () => {
    expect(() => resolveEnvironment("staging")).toThrowError(
      "Invalid application environment",
    );
  });

  it("reports unsupported non-JSON values through the configuration error contract", () => {
    const cyclic = { self: undefined as unknown };
    cyclic.self = cyclic;
    const toJSON = () => { throw new Error("caller serialization must not run"); };
    const callable = Object.assign(() => {}, { toString: toJSON });
    for (const [value, description] of [
      [1n, "1"], [null, "null"], [cyclic, "object"], [{ toJSON }, "object"], [callable, "function"],
    ] as const) {
      expect(() => resolveEnvironment(value)).toThrow(ConfigurationError);
      expect(() => resolveEnvironment(value))
        .toThrow(`Invalid application environment ${description}. Expected one of: development, test, preview, production.`);
    }
  });
});

describe("configuration boundary contracts", () => {
  const api = createConfigurationApi({
    environments: ["test", "production"], defaultEnvironment: "test",
    environmentOverrides: { prefix: "CFG" },
  });

  it("validates the entire prefix and reserves only names beneath it", () => {
    expect(() => createConfigurationApi({
      environments: ["test"], defaultEnvironment: "test",
      environmentOverrides: { prefix: "CFG.invalid" },
    })).toThrow('Invalid conventional environment variable prefix "CFG.invalid".');
    expect(api.resolveConfig({}, {
      env: { CFG: "ordinary", OTHER__SETTING: "ordinary", CFG__OMITTED: undefined },
    })).toEqual({});
  });

  it("preserves detailed causes and paths through conventional and explicit validation", () => {
    const schema = z.string().min(3, "too short").regex(/^[A-Z]+$/u, "uppercase only");
    const base = defineConfigBase(z.object({ field: schema }));
    const check = (run: () => unknown, message: string) => {
      expect(run).toThrow(expect.objectContaining({
        name: "ConfigurationError", message, cause: expect.any(z.ZodError),
      }));
    };
    check(() => api.resolveConfig({ service: configure(base, { field: "OKAY" }) }, {
      env: { CFG__SERVICE__FIELD: "a" },
    }), 'Invalid conventional environment variable "CFG__SERVICE__FIELD" at "service.field": too short; uppercase only');
    check(() => api.resolveConfig({ entries: ["valid", api.envVar("EXPLICIT", schema)] }, {
      env: { EXPLICIT: "a" },
    }), 'Invalid environment variable "EXPLICIT" at "entries.1": too short; uppercase only');
    check(() => api.resolveConfig({ entries: [configure(base, { field: "a" })] }, { env: {} }),
      "Invalid configuration: entries.0.field: too short; entries.0.field: uppercase only");
    check(() => api.resolveEnvironment("unknown"), 'Invalid application environment "unknown". Expected one of: test, production.');
  });

  it("resolves prototype-free definitions without treating class instances as config branches", () => {
    class OpaqueSetting {
      public readonly value = api.envVar("OPAQUE");
    }
    const opaque = new OpaqueSetting();
    const prototypeFree = Object.assign(Object.create(null) as { field: typeof opaque.value }, {
      field: api.envVar("FIELD"),
    });
    const result = api.resolveConfig({ prototypeFree, opaque, nil: null }, { env: { FIELD: "present" } });
    expect(result.prototypeFree).toEqual({ field: "present" });
    expect(result.opaque).toBe(opaque);
    expect(result.nil).toBeNull();
  });

  it("discovers leaves through object wrappers and preserves acronym boundaries", () => {
    const nested = z.object({ TLSConfig: z.string().default("default") });
    const base = defineConfigBase(z.object({
      nullable: nested.nullable(),
      prefault: nested.prefault({ TLSConfig: "prefault" }),
      fallback: nested.catch({ TLSConfig: "fallback" }),
      readonly: nested.readonly(),
      required: nested.optional().nonoptional(),
    }));
    const definition = { library: configure(base, {
      nullable: null, fallback: api.fromEnv({ test: undefined }), readonly: {}, required: {},
    }) };
    const result = api.resolveConfig(definition, { env: {
      CFG__LIBRARY__NULLABLE__TLS_CONFIG: "nullable",
      CFG__LIBRARY__PREFAULT__TLS_CONFIG: "prefaulted",
      CFG__LIBRARY__FALLBACK__TLS_CONFIG: "fallback-value",
      CFG__LIBRARY__READONLY__TLS_CONFIG: "readonly",
      CFG__LIBRARY__REQUIRED__TLS_CONFIG: "required",
    } });
    expect(result.library).toEqual({
      nullable: { TLSConfig: "nullable" }, prefault: { TLSConfig: "prefaulted" },
      fallback: { TLSConfig: "fallback-value" }, readonly: { TLSConfig: "readonly" },
      required: { TLSConfig: "required" },
    });
    expect(Object.isFrozen(result.library.readonly)).toBe(true);
  });

  it("accepts the same conventional path discovered in a nested contribution", () => {
    const schema = z.object({ port: z.number() });
    const root = defineConfigBase(z.object({ adapter: schema }));
    const adapter = configure(defineConfigBase(schema), { port: 8080 });
    const config = api.resolveConfig({ service: configure(root, { adapter: api.fromEnv({ test: adapter }) }) }, {
      env: { CFG__SERVICE__ADAPTER__PORT: "9090" },
    });
    expect(config.service.adapter.port).toBe(9090);
  });

  it("materializes only the optional branch containing a supplied override", () => {
    const nested = z.object({ host: z.string() }).optional();
    const base = defineConfigBase(z.object({ cache: nested, cacheBackup: nested }));
    expect(api.resolveConfig({ service: configure(base, {}) }, {
      env: { CFG__SERVICE__CACHE_BACKUP__HOST: "backup" },
    })).toStrictEqual({ service: { cacheBackup: { host: "backup" } } });
  });

  it("reports every explicit variable used by a composed source on the same path", () => {
    const base = defineConfigBase(z.object({ label: z.string() }));
    const fallback = api.envVar("INNER", { fallback: "label" });
    const label = api.envVar("OUTER", { fallback });
    expect(() => api.resolveConfig({ service: configure(base, { label }) }, {
      env: { CFG__SERVICE__LABEL: "override" },
    })).toThrow('Conventional environment variable "CFG__SERVICE__LABEL" cannot override "service.label" because that path explicitly uses envVar("OUTER"), envVar("INNER").');
  });

  const object = z.object({ value: z.string() });
  it.each([
    ["tuple", z.tuple([z.string()]), ["value"]],
    ["record", z.record(z.string(), z.string()), { key: "value" }],
    ["map", z.map(z.string(), z.string()), new Map([["key", "value"]])],
    ["set", z.set(z.string()), new Set(["value"])],
    ["intersection", z.intersection(object, object), { value: "value" }],
    ["lazy", z.lazy(() => z.string()), "value"],
    ["object pipe", object.pipe(z.custom<{ value: string }>()), { value: "value" }],
    ["array pipe", z.array(z.string()).pipe(z.custom<string[]>()), ["value"]],
    ["mixed object union", z.union([z.string(), object]), "value"],
    ["mixed array union", z.union([z.string(), z.array(z.string())]), "value"],
  ] as const)("excludes unstable %s inputs from conventional aliases", (_label, schema, value) => {
    const base = defineConfigBase(z.object({ field: schema }));
    // An explicit binding can still populate the field using the application's own input.
    const definition = { service: configure(base, { field: api.fromEnv({ test: value }) }) };
    expect(api.resolveConfig(definition, { env: {} }).service.field).toEqual(value);
    expect(() => api.resolveConfig(definition, { env: { CFG__SERVICE__FIELD: "replacement" } }))
      .toThrow('Unknown conventional environment variable "CFG__SERVICE__FIELD".');
  });
});
