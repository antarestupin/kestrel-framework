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

  it("reports the variable and config path for invalid overrides", () => {
    const { defineConfig, resolveConfig } = createConventionalApi();
    const base = defineConfigBase(z.object({
      port: z.coerce.number().int().positive().default(3_333),
    }));
    const definition = defineConfig({ http: configure(base, {}) });

    expect(() => resolveConfig(definition, {
      env: { APP_CONFIG__HTTP__PORT: "invalid" },
    })).toThrowError(
      'Invalid conventional environment variable "APP_CONFIG__HTTP__PORT" at "http.port"',
    );
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
});
