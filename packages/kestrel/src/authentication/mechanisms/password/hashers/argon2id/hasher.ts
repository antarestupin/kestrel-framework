import {
  argon2,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { PasswordHasher } from "../../types.js";

export interface Argon2idPasswordHasherOptions {
  readonly memoryKiB?: number;
  readonly passes?: number;
  readonly parallelism?: number;
  readonly saltBytes?: number;
  readonly tagBytes?: number;
  readonly verificationLimits?: Argon2idVerificationLimits;
  readonly pepper?: Uint8Array;
  readonly createSalt?: (bytes: number) => Uint8Array;
}

/** Resource limits applied to parameters read from stored password hashes. */
export interface Argon2idVerificationLimits {
  readonly maxEncodedHashChars?: number;
  readonly maxMemoryKiB?: number;
  readonly maxPasses?: number;
  readonly maxParallelism?: number;
  readonly maxSaltBytes?: number;
  readonly maxTagBytes?: number;
}

interface ResolvedArgon2idOptions {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly saltBytes: number;
  readonly tagBytes: number;
  readonly pepper?: Uint8Array;
}

interface ResolvedArgon2idVerificationLimits {
  readonly maxEncodedHashChars: number;
  readonly maxMemoryKiB: number;
  readonly maxPasses: number;
  readonly maxParallelism: number;
  readonly maxSaltBytes: number;
  readonly maxTagBytes: number;
}

const dummyPassword = "kestrel-authentication-dummy-password";

// Verification accepts parameter migrations while placing a finite resource budget
// around values read from the credential store.
const defaultVerificationLimits: ResolvedArgon2idVerificationLimits = {
  maxEncodedHashChars: 1_024,
  maxMemoryKiB: 256 * 1_024,
  maxPasses: 10,
  maxParallelism: 16,
  maxSaltBytes: 64,
  maxTagBytes: 64,
};

/** Configurable asynchronous Argon2id password hasher. */
export class Argon2idPasswordHasher implements PasswordHasher {
  public readonly id = "argon2id";

  private readonly options: ResolvedArgon2idOptions;

  private readonly verificationLimits: ResolvedArgon2idVerificationLimits;

  private readonly createSalt: (bytes: number) => Uint8Array;

  private dummyHash: Promise<string> | undefined;

  public constructor(options: Argon2idPasswordHasherOptions = {}) {
    this.options = {
      memoryKiB: options.memoryKiB ?? 19_456,
      passes: options.passes ?? 2,
      parallelism: options.parallelism ?? 1,
      saltBytes: options.saltBytes ?? 16,
      tagBytes: options.tagBytes ?? 32,
      ...(options.pepper === undefined ? {} : { pepper: options.pepper }),
    };
    this.verificationLimits = {
      maxEncodedHashChars: options.verificationLimits?.maxEncodedHashChars
        ?? defaultVerificationLimits.maxEncodedHashChars,
      maxMemoryKiB: options.verificationLimits?.maxMemoryKiB
        ?? defaultVerificationLimits.maxMemoryKiB,
      maxPasses: options.verificationLimits?.maxPasses
        ?? defaultVerificationLimits.maxPasses,
      maxParallelism: options.verificationLimits?.maxParallelism
        ?? defaultVerificationLimits.maxParallelism,
      maxSaltBytes: options.verificationLimits?.maxSaltBytes
        ?? defaultVerificationLimits.maxSaltBytes,
      maxTagBytes: options.verificationLimits?.maxTagBytes
        ?? defaultVerificationLimits.maxTagBytes,
    };
    this.createSalt = options.createSalt ?? randomBytes;
    validateOptions(this.options);
    validateVerificationLimits(this.verificationLimits, this.options);
  }

  public async hash(password: string): Promise<string> {
    const salt = this.createSalt(this.options.saltBytes);
    const tag = await derive(password, salt, this.options);

    return encodeHash(this.options, salt, tag);
  }

  public async verify(
    password: string,
    encodedHash: string,
  ): Promise<boolean> {
    const parsed = parseHash(encodedHash, this.verificationLimits);

    if (parsed === undefined) {
      return false;
    }

    const actual = await derive(password, parsed.salt, {
      ...parsed.options,
      ...(this.options.pepper === undefined
        ? {}
        : { pepper: this.options.pepper }),
    });

    return actual.byteLength === parsed.tag.byteLength
      && timingSafeEqual(actual, parsed.tag);
  }

  public needsRehash(encodedHash: string): boolean {
    const parsed = parseHash(encodedHash, this.verificationLimits);

    return parsed === undefined
      || parsed.options.memoryKiB !== this.options.memoryKiB
      || parsed.options.passes !== this.options.passes
      || parsed.options.parallelism !== this.options.parallelism
      || parsed.options.saltBytes !== this.options.saltBytes
      || parsed.options.tagBytes !== this.options.tagBytes;
  }

  public getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hash(dummyPassword);
    return this.dummyHash;
  }
}

function derive(
  password: string,
  salt: Uint8Array,
  options: ResolvedArgon2idOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", {
      message: password,
      nonce: salt,
      parallelism: options.parallelism,
      tagLength: options.tagBytes,
      memory: options.memoryKiB,
      passes: options.passes,
      ...(options.pepper === undefined ? {} : { secret: options.pepper }),
    }, (error, value) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

function encodeHash(
  options: ResolvedArgon2idOptions,
  salt: Uint8Array,
  tag: Uint8Array,
): string {
  return [
    "$argon2id$v=19",
    `m=${options.memoryKiB},t=${options.passes},p=${options.parallelism}`,
    Buffer.from(salt).toString("base64url"),
    Buffer.from(tag).toString("base64url"),
  ].join("$");
}

function parseHash(
  encodedHash: string,
  limits: ResolvedArgon2idVerificationLimits,
): {
  readonly options: ResolvedArgon2idOptions;
  readonly salt: Buffer;
  readonly tag: Buffer;
} | undefined {
  // Bound regex work and all subsequent parsing before decoding attacker-controlled
  // base64url fields into allocated buffers.
  if (encodedHash.length > limits.maxEncodedHashChars) {
    return undefined;
  }

  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
    encodedHash,
  );

  if (match === null) {
    return undefined;
  }

  const memoryKiB = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (
    !isPositiveIntegerAtMost(memoryKiB, limits.maxMemoryKiB)
    || !isPositiveIntegerAtMost(passes, limits.maxPasses)
    || !isPositiveIntegerAtMost(parallelism, limits.maxParallelism)
    || match[4]!.length > maxBase64urlChars(limits.maxSaltBytes)
    || match[5]!.length > maxBase64urlChars(limits.maxTagBytes)
  ) {
    return undefined;
  }

  const salt = Buffer.from(match[4]!, "base64url");
  const tag = Buffer.from(match[5]!, "base64url");
  const options: ResolvedArgon2idOptions = {
    memoryKiB,
    passes,
    parallelism,
    saltBytes: salt.byteLength,
    tagBytes: tag.byteLength,
  };

  try {
    validateOptions(options);
    if (
      options.saltBytes > limits.maxSaltBytes
      || options.tagBytes > limits.maxTagBytes
    ) {
      return undefined;
    }
    return { options, salt, tag };
  } catch {
    return undefined;
  }
}

function validateVerificationLimits(
  limits: ResolvedArgon2idVerificationLimits,
  options: ResolvedArgon2idOptions,
): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  for (const [name, value, maximum] of [
    ["memoryKiB", options.memoryKiB, limits.maxMemoryKiB],
    ["passes", options.passes, limits.maxPasses],
    ["parallelism", options.parallelism, limits.maxParallelism],
    ["saltBytes", options.saltBytes, limits.maxSaltBytes],
    ["tagBytes", options.tagBytes, limits.maxTagBytes],
  ] as const) {
    if (value > maximum) {
      throw new TypeError(`${name} must not exceed its verification limit.`);
    }
  }

  if (encodedHashLength(options) > limits.maxEncodedHashChars) {
    throw new TypeError(
      "Argon2id hash output must fit within maxEncodedHashChars.",
    );
  }
}

function isPositiveIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function maxBase64urlChars(bytes: number): number {
  return Math.ceil(bytes * 4 / 3);
}

function encodedHashLength(options: ResolvedArgon2idOptions): number {
  return "$argon2id$v=19$m=,t=,p=$$".length
    + String(options.memoryKiB).length
    + String(options.passes).length
    + String(options.parallelism).length
    + maxBase64urlChars(options.saltBytes)
    + maxBase64urlChars(options.tagBytes);
}

function validateOptions(options: ResolvedArgon2idOptions): void {
  for (const [name, value] of [
    ["memoryKiB", options.memoryKiB],
    ["passes", options.passes],
    ["parallelism", options.parallelism],
    ["saltBytes", options.saltBytes],
    ["tagBytes", options.tagBytes],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  if (options.memoryKiB < 8 * options.parallelism) {
    throw new TypeError("Argon2id memory is too small for its parallelism.");
  }

  if (options.saltBytes < 16) {
    throw new TypeError("Argon2id salts must contain at least 16 bytes.");
  }

  if (options.tagBytes < 16) {
    throw new TypeError("Argon2id tags must contain at least 16 bytes.");
  }
}
