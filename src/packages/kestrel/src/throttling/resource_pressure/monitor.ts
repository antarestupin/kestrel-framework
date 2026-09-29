import type {
  LocalResourcePressureSignalDefinition,
  ResourcePressureUnavailableBehavior,
} from "../definitions.js";

export type LocalResourcePressureState =
  | "degraded"
  | "healthy"
  | "limited"
  | "unknown";

export interface LocalResourcePressureSource {
  /** Returns whether this source owns the stable signal identifier. */
  supports(signalId: string): boolean;
  /** Reads a non-negative finite value, or undefined when temporarily unavailable. */
  read(signalId: string): number | undefined;
  close?(): void;
}

export interface LocalResourcePressureSamplingOptions {
  readonly healthyIntervalMs?: number;
  readonly nearThresholdIntervalMs?: number;
  readonly pressuredIntervalMs?: number;
  readonly nearThresholdRatio?: number;
}

export interface LocalResourcePressureSignalEvaluation {
  readonly signalId: string;
  readonly state: LocalResourcePressureState;
  readonly previousState?: LocalResourcePressureState;
  readonly value?: number;
}

export interface LocalResourcePressureEvaluation {
  readonly state: LocalResourcePressureState;
  readonly signals: readonly LocalResourcePressureSignalEvaluation[];
  /** Wall-clock deadline at which a waiting admission should sample again. */
  readonly refreshAt: Date;
}

interface CachedSignal {
  refreshAtMs: number;
  value?: number;
}

const DEFAULT_HEALTHY_INTERVAL_MS = 1_000;
const DEFAULT_NEAR_THRESHOLD_INTERVAL_MS = 500;
const DEFAULT_PRESSURED_INTERVAL_MS = 250;
const DEFAULT_NEAR_THRESHOLD_RATIO = 0.2;

/**
 * Shares short-lived local measurements across every admission policy.
 *
 * Sampling is lazy: an admission or inspection reads an expired snapshot, and
 * a bounded waiter wakes at the returned refresh deadline. No timer is needed
 * when an application declares no pressure constraint.
 */
export class LocalResourcePressureMonitor {
  private readonly healthyIntervalMs: number;

  private readonly nearThresholdIntervalMs: number;

  private readonly pressuredIntervalMs: number;

  private readonly nearThresholdRatio: number;

  private readonly cachedSignals = new Map<string, CachedSignal>();

  private readonly states = new Map<string, LocalResourcePressureState>();

  private closed = false;

  public constructor(
    private readonly sources: readonly LocalResourcePressureSource[],
    options: LocalResourcePressureSamplingOptions & {
      readonly monotonicNow?: () => number;
      readonly now?: () => Date;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.healthyIntervalMs = options.healthyIntervalMs
      ?? DEFAULT_HEALTHY_INTERVAL_MS;
    this.nearThresholdIntervalMs = options.nearThresholdIntervalMs
      ?? DEFAULT_NEAR_THRESHOLD_INTERVAL_MS;
    this.pressuredIntervalMs = options.pressuredIntervalMs
      ?? DEFAULT_PRESSURED_INTERVAL_MS;
    this.nearThresholdRatio = options.nearThresholdRatio
      ?? DEFAULT_NEAR_THRESHOLD_RATIO;
    validateSamplingOptions({
      healthyIntervalMs: this.healthyIntervalMs,
      nearThresholdIntervalMs: this.nearThresholdIntervalMs,
      pressuredIntervalMs: this.pressuredIntervalMs,
      nearThresholdRatio: this.nearThresholdRatio,
    });
  }

  private readonly now: () => Date;

  private readonly monotonicNow: () => number;

  public supports(signalId: string): boolean {
    return this.sources.some((source) => source.supports(signalId));
  }

  /** Evaluates all signals and advances their hysteresis state atomically. */
  public evaluate(
    constraintKey: string,
    signals: readonly LocalResourcePressureSignalDefinition[],
    unavailable: ResourcePressureUnavailableBehavior,
  ): LocalResourcePressureEvaluation {
    if (this.closed) {
      return this.unknownEvaluation(constraintKey, signals);
    }

    const nowMs = this.getMonotonicNowMs();
    const wallNowMs = this.getWallNowMs();
    const evaluations = signals.map((signal) =>
      this.evaluateSignal(constraintKey, signal, nowMs));
    const state = aggregateState(evaluations, unavailable);
    const refreshAtMs = Math.min(...signals.map((signal) =>
      this.cachedSignals.get(signal.id)?.refreshAtMs
        ?? nowMs + this.pressuredIntervalMs));

    return {
      state,
      signals: evaluations,
      refreshAt: new Date(wallNowMs + Math.max(1, refreshAtMs - nowMs)),
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const source of this.sources) source.close?.();
    this.cachedSignals.clear();
    this.states.clear();
  }

  private evaluateSignal(
    constraintKey: string,
    signal: LocalResourcePressureSignalDefinition,
    nowMs: number,
  ): LocalResourcePressureSignalEvaluation {
    const cached = this.readSignal(signal.id, nowMs);
    const stateKey = `${constraintKey}:${signal.id}`;
    const previousState = this.states.get(stateKey);
    const state = cached.value === undefined
      ? "unknown"
      : classifySignal(cached.value, signal, previousState);
    this.states.set(stateKey, state);

    const intervalMs = this.selectInterval(signal, state, cached.value);
    cached.refreshAtMs = Math.min(
      cached.refreshAtMs,
      nowMs + intervalMs,
    );

    return {
      signalId: signal.id,
      state,
      ...(previousState === undefined || previousState === state
        ? {}
        : { previousState }),
      ...(cached.value === undefined ? {} : { value: cached.value }),
    };
  }

  private readSignal(signalId: string, nowMs: number): CachedSignal {
    const cached = this.cachedSignals.get(signalId);
    if (cached !== undefined && nowMs < cached.refreshAtMs) return cached;

    const source = this.sources.find((candidate) =>
      candidate.supports(signalId));
    let value: number | undefined;

    try {
      value = source?.read(signalId);
    } catch {
      // A broken pressure reader is represented as unavailable state.
      value = undefined;
    }

    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      value = undefined;
    }

    const next: CachedSignal = {
      refreshAtMs: nowMs + this.healthyIntervalMs,
      ...(value === undefined ? {} : { value }),
    };
    this.cachedSignals.set(signalId, next);
    return next;
  }

  private selectInterval(
    signal: LocalResourcePressureSignalDefinition,
    state: LocalResourcePressureState,
    value: number | undefined,
  ): number {
    if (state !== "healthy" || value === undefined) {
      return this.pressuredIntervalMs;
    }

    const nearThreshold = signal.degradedAt
      * (1 - this.nearThresholdRatio);
    return value >= nearThreshold
      ? this.nearThresholdIntervalMs
      : this.healthyIntervalMs;
  }

  private unknownEvaluation(
    constraintKey: string,
    signals: readonly LocalResourcePressureSignalDefinition[],
  ): LocalResourcePressureEvaluation {
    const nowMs = this.getMonotonicNowMs();
    const wallNowMs = this.getWallNowMs();
    return {
      state: "unknown",
      signals: signals.map((signal) => {
        const stateKey = `${constraintKey}:${signal.id}`;
        const previousState = this.states.get(stateKey);
        this.states.set(stateKey, "unknown");
        return {
          signalId: signal.id,
          state: "unknown",
          ...(previousState === undefined || previousState === "unknown"
            ? {}
            : { previousState }),
        };
      }),
      refreshAt: new Date(wallNowMs + this.pressuredIntervalMs),
    };
  }

  private getWallNowMs(): number {
    const value = this.now().getTime();
    if (!Number.isFinite(value)) {
      throw new TypeError("The resource pressure clock returned an invalid date.");
    }

    return value;
  }

  private getMonotonicNowMs(): number {
    const value = this.monotonicNow();
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "The resource pressure monotonic clock returned an invalid value.",
      );
    }

    return value;
  }
}

function classifySignal(
  value: number,
  signal: LocalResourcePressureSignalDefinition,
  previousState: LocalResourcePressureState | undefined,
): LocalResourcePressureState {
  if (value >= signal.limitedAt) return "limited";
  if (
    previousState === "limited"
    && value >= signal.limitedAt * signal.recoveryRatio
  ) {
    return "limited";
  }

  if (value >= signal.degradedAt) return "degraded";
  if (
    (previousState === "degraded" || previousState === "limited")
    && value >= signal.degradedAt * signal.recoveryRatio
  ) {
    return "degraded";
  }

  return "healthy";
}

function aggregateState(
  evaluations: readonly LocalResourcePressureSignalEvaluation[],
  unavailable: ResourcePressureUnavailableBehavior,
): LocalResourcePressureState {
  if (evaluations.some((evaluation) => evaluation.state === "limited")) {
    return "limited";
  }

  if (evaluations.some((evaluation) => evaluation.state === "unknown")) {
    // Ignoring an unavailable reader permits work but remains observable as
    // degraded rather than pretending that the process is known to be healthy.
    return unavailable === "reject" ? "unknown" : "degraded";
  }

  return evaluations.some((evaluation) => evaluation.state === "degraded")
    ? "degraded"
    : "healthy";
}

function validateSamplingOptions(options: {
  healthyIntervalMs: number;
  nearThresholdIntervalMs: number;
  pressuredIntervalMs: number;
  nearThresholdRatio: number;
}): void {
  for (const [name, value] of [
    ["healthyIntervalMs", options.healthyIntervalMs],
    ["nearThresholdIntervalMs", options.nearThresholdIntervalMs],
    ["pressuredIntervalMs", options.pressuredIntervalMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }

  if (
    options.pressuredIntervalMs > options.nearThresholdIntervalMs
    || options.nearThresholdIntervalMs > options.healthyIntervalMs
  ) {
    throw new TypeError(
      "Pressure sampling intervals must increase from pressured to healthy state.",
    );
  }

  if (
    !Number.isFinite(options.nearThresholdRatio)
    || options.nearThresholdRatio < 0
    || options.nearThresholdRatio >= 1
  ) {
    throw new TypeError("nearThresholdRatio must be between zero and one.");
  }
}
