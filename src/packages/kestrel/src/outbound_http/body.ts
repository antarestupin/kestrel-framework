import { OutboundHttpDeadline } from "./deadline.js";
import { OutboundHttpResponseTooLargeError } from "./errors.js";

/** Bounds each response representation without buffering or teeing native streams. */
export class OutboundHttpBodies {
  private readonly states = new WeakMap<Response, { truncated: boolean }>();
  private readonly streams = new WeakMap<ReadableStream, { truncated: boolean }>();
  private violation: OutboundHttpResponseTooLargeError | undefined;
  private readonly active = new Map<Response, (reason?: unknown) => void>();
  private closed = false;

  public constructor(
    private readonly operation: string,
    private readonly deadline: OutboundHttpDeadline,
    private readonly maximumBytes: number,
    private readonly maximumErrorBytes: number | undefined,
  ) {}

  public truncated(response: Response): boolean {
    return this.states.get(response)?.truncated ?? false;
  }

  public check(): void {
    if (this.violation !== undefined) throw this.violation;
  }

  public protect(response: Response): Response {
    if (this.states.has(response) || response.body === null) return response;
    const existing = this.streams.get(response.body);
    if (existing !== undefined) {
      this.states.set(response, existing);
      return response;
    }
    const state = { truncated: false };
    const reader = response.body.getReader();
    const truncate = !response.ok && this.maximumErrorBytes !== undefined;
    const limit = truncate
      ? Math.min(this.maximumBytes, this.maximumErrorBytes!)
      : this.maximumBytes;
    let size = 0;
    let finished = false;
    let target: Response;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const release = () => {
      this.deadline.signal.removeEventListener("abort", abort);
      this.active.delete(target);
      reader.releaseLock();
    };
    const cancel = (reason?: unknown) => {
      if (finished) return;
      finished = true;
      // Cancellation requests disposal, but a non-cooperative source cannot delay rejection.
      void reader.cancel(reason).catch(() => {});
      release();
    };
    const fail = (reason: unknown) => {
      if (finished) return;
      if (reason instanceof OutboundHttpResponseTooLargeError) this.violation ??= reason;
      controller.error(reason);
      cancel(reason);
    };
    const abort = () => fail(this.deadline.error());
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => { controller = value; },
      pull: async () => {
        try {
          const result = await reader.read();
          if (finished) return;
          if (result.done) {
            finished = true;
            controller.close();
            release();
            return;
          }
          const remaining = limit - size;
          if (result.value.byteLength > remaining) {
            if (!truncate) {
              fail(new OutboundHttpResponseTooLargeError(this.operation, limit));
              return;
            }
            state.truncated = true;
            if (remaining > 0) controller.enqueue(result.value.slice(0, remaining));
            controller.close();
            cancel();
            return;
          }
          size += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error: unknown) {
          fail(error);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    target = new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Reconstructing a streaming Response otherwise loses transport metadata.
    for (const key of ["url", "redirected", "type"] as const) {
      Object.defineProperty(target, key, { value: response[key] });
    }
    this.states.set(target, state);
    this.streams.set(stream, state);
    this.active.set(target, fail);
    this.deadline.signal.addEventListener("abort", abort, { once: true });
    if (this.deadline.signal.aborted) abort();
    else if (this.closed) fail(new Error("The outbound HTTP operation has completed."));
    return target;
  }

  public close(retained?: Response): void {
    this.closed = true;
    // Middleware may compose streams from earlier responses. Transfer the entire
    // live pipeline; its owners must consume/cancel it, including any cloned branches.
    if (retained !== undefined) return;
    for (const cancel of this.active.values()) cancel();
  }
}

/** Validate budgets at construction and before starting any request. */
export function validateResponseLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("An outbound HTTP response limit must be a positive safe integer.");
  }
}
