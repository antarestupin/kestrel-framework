import {
  summarizeEmailCapture,
  type EmailCapture,
  type EmailCapturePage,
  type EmailCapturePageOptions,
  type EmailCaptureStore,
  type NewEmailCapture,
} from "../../capture.js";
import { normalizeEmailMessage } from "../../message.js";

const defaultPageSize = 50;
const maximumPageSize = 100;

/** Process-local capture storage with the same pagination contract as PostgreSQL. */
export class MemoryEmailCaptureStore implements EmailCaptureStore {
  private readonly captures = new Map<string, EmailCapture>();

  private nextSequence = 1;

  public async capture(capture: NewEmailCapture): Promise<void> {
    if (this.captures.has(capture.id)) {
      throw new Error(`Email capture "${capture.id}" already exists.`);
    }

    this.captures.set(capture.id, cloneCapture({
      ...capture,
      sequence: this.nextSequence++,
    }));
  }

  public async clear(): Promise<void> {
    this.captures.clear();
  }

  public async get(id: string): Promise<EmailCapture | undefined> {
    const capture = this.captures.get(id);

    return capture === undefined ? undefined : cloneCapture(capture);
  }

  public async list(
    options: EmailCapturePageOptions = {},
  ): Promise<EmailCapturePage> {
    const limit = Math.min(
      Math.max(options.limit ?? defaultPageSize, 1),
      maximumPageSize,
    );
    const items = [...this.captures.values()]
      .filter((capture) =>
        options.before === undefined || capture.sequence < options.before)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit + 1);
    const hasNextPage = items.length > limit;
    const visibleItems = hasNextPage ? items.slice(0, limit) : items;

    return {
      items: visibleItems.map(summarizeEmailCapture),
      nextBefore: hasNextPage
        ? (visibleItems.at(-1)?.sequence ?? null)
        : null,
    };
  }
}

function cloneCapture(capture: EmailCapture): EmailCapture {
  return {
    sequence: capture.sequence,
    id: capture.id,
    observationId: capture.observationId,
    capturedAt: new Date(capture.capturedAt),
    message: normalizeEmailMessage(capture.message),
  };
}
