import { definition as faEnvelope } from "@fortawesome/free-solid-svg-icons/faEnvelope";
import { z } from "zod";

import {
  contentBytes,
  EmailCaptureNotFoundError,
  type EmailCapture,
  type EmailCaptureInboxSource,
  type EmailCaptureSummary,
} from "../../../email/index.js";
import {
  del,
  defineHttpController,
  get,
  post,
} from "../../../http/index.js";
import type { DevObservationSource } from "../../../observability/index.js";
import type { StudioExtension } from "../../extension.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import { joinStudioPath } from "../../studio.js";
import {
  DEV_EMAIL_CAPTURE_PAGE_KIND,
  DEV_EMAIL_DATA_PATH,
  DEV_EMAIL_EXTENSION_ID,
  DEV_EMAIL_HISTORY_PAGE_KIND,
  DEV_EMAIL_INBOX_PAGE_KIND,
  type StudioEmailAddress,
  type StudioEmailCaptureDetail,
  type StudioEmailCapturePage,
  type StudioEmailCaptureSummary,
  type StudioEmailHistoryItem,
  type StudioEmailHistoryPage,
  type StudioEmailObservation,
  type StudioEmailResendResult,
} from "./contract.js";

const emailIcon = fontAwesomeIcon(faEnvelope);
const listInput = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
const captureInput = z.object({ captureId: z.uuid() });
const sensitiveHeaderName = /(?:authorization|cookie|credential|password|secret|token|x-api-key)/iu;

/** Adds the local capture inbox, redacted details and development controls. */
export function defineDevEmailExtension(
  source: EmailCaptureInboxSource,
  observations: DevObservationSource,
): StudioExtension {
  return {
    id: DEV_EMAIL_EXTENSION_ID,
    title: "Development email",
    icon: emailIcon,
    description: "Inspect transactional emails captured by the local application.",
    section: { id: "app", title: "App", order: 20 },
    pages: [
      {
        id: "history",
        title: "Email history",
        path: "/email-history",
        description: "Timing and normalized outcomes for transactional sends.",
        kind: DEV_EMAIL_HISTORY_PAGE_KIND,
        icon: emailIcon,
        dataPath: DEV_EMAIL_DATA_PATH,
        order: 40,
      },
      {
        id: "inbox",
        title: "Email inbox",
        path: "/emails",
        description: "Messages captured locally without contacting recipients.",
        kind: DEV_EMAIL_INBOX_PAGE_KIND,
        icon: emailIcon,
        dataPath: DEV_EMAIL_DATA_PATH,
        order: 50,
      },
      {
        id: "capture",
        title: "Captured email",
        path: "/emails/$captureId",
        description: "Safe preview and diagnostics for one captured message.",
        kind: DEV_EMAIL_CAPTURE_PAGE_KIND,
        icon: emailIcon,
        dataPath: DEV_EMAIL_DATA_PATH,
        showInNavigation: false,
      },
    ],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, DEV_EMAIL_DATA_PATH);

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/history`),
          description: "List transactional email send observations.",
          input: listInput,
          handler: async ({ input }): Promise<StudioEmailHistoryPage> => {
            const page = await observations.listObservations({
              name: "email.send",
              ...(input.before === undefined ? {} : { before: input.before }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });

            return {
              items: page.items.map(serializeHistoryItem),
              nextBefore: page.nextBefore,
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/captures`),
          description: "List locally captured emails.",
          input: listInput,
          handler: async ({ input }): Promise<StudioEmailCapturePage> => {
            const page = await source.list({
              ...(input.before === undefined ? {} : { before: input.before }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });

            return {
              items: page.items.map(serializeSummary),
              nextBefore: page.nextBefore,
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: del(`${root}/captures`),
          description: "Clear the local email capture inbox.",
          successStatusCode: 204,
          handler: async () => {
            await source.clear();
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/captures/:captureId`),
          description: "Read one captured email and its send observation.",
          input: captureInput,
          handler: async ({ input, reply }) => {
            const capture = await source.get(input.captureId);

            if (capture === undefined) {
              return reply.code(404).send({
                statusCode: 404,
                error: "Not Found",
                message: "The captured email does not exist or has expired.",
              });
            }

            const observation = await observations.getObservation(
              capture.observationId,
            );

            return serializeDetail(capture, observation === undefined
              ? null
              : {
                  id: observation.id,
                  executionId: observation.executionId,
                  occurredAt: observation.occurredAt.toISOString(),
                  outcome: observation.outcome,
                  durationMs: observation.durationMs,
                  operation: stringData(observation.data.operation),
                  transport: stringData(observation.data.transport),
                  result: stringData(observation.data.result),
                });
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/captures/:captureId/resend`),
          description: "Replay one captured email through the configured local transport.",
          input: captureInput,
          handler: async ({ input, reply }) => {
            try {
              const result = await source.resend(input.captureId);

              return {
                captureId: result.receipt.captureId ?? null,
                messageId: result.receipt.messageId ?? null,
              } satisfies StudioEmailResendResult;
            } catch (error: unknown) {
              if (error instanceof EmailCaptureNotFoundError) {
                return reply.code(404).send({
                  statusCode: 404,
                  error: "Not Found",
                  message: "The captured email does not exist or has expired.",
                });
              }

              throw error;
            }
          },
        }),
      ];
    },
  };
}

function serializeHistoryItem(
  observation: Awaited<ReturnType<DevObservationSource["listObservations"]>>["items"][number],
): StudioEmailHistoryItem {
  return {
    sequence: observation.sequence,
    id: observation.id,
    executionId: observation.executionId,
    occurredAt: observation.occurredAt.toISOString(),
    outcome: observation.outcome,
    durationMs: observation.durationMs,
    client: stringData(observation.data.client),
    operation: stringData(observation.data.operation),
    transport: stringData(observation.data.transport),
    result: stringData(observation.data.result),
    recipientCount: numberData(observation.data.recipientCount),
    attachmentCount: numberData(observation.data.attachmentCount),
    captureId: stringData(observation.data.captureId),
  };
}

function serializeDetail(
  capture: EmailCapture,
  observation: StudioEmailObservation | null,
): StudioEmailCaptureDetail {
  return {
    ...serializeSummary({
      sequence: capture.sequence,
      id: capture.id,
      observationId: capture.observationId,
      capturedAt: capture.capturedAt,
      from: capture.message.from,
      to: capture.message.to,
      cc: capture.message.cc,
      bcc: capture.message.bcc,
      subject: capture.message.subject,
      hasText: capture.message.text !== undefined,
      hasHtml: capture.message.html !== undefined,
      attachmentCount: capture.message.attachments.length,
      attachmentBytes: capture.message.attachments.reduce(
        (total, attachment) => total + contentBytes(attachment.content),
        0,
      ),
    }),
    replyTo: capture.message.replyTo.map(serializeAddress),
    text: capture.message.text ?? null,
    html: capture.message.html ?? null,
    headers: redactHeaders(capture.message.headers),
    attachments: capture.message.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType ?? null,
      disposition: attachment.disposition ?? null,
      contentId: attachment.contentId ?? null,
      size: contentBytes(attachment.content),
    })),
    observation,
  };
}

function serializeSummary(
  capture: EmailCaptureSummary,
): StudioEmailCaptureSummary {
  return {
    ...capture,
    capturedAt: capture.capturedAt.toISOString(),
    from: serializeAddress(capture.from),
    to: capture.to.map(serializeAddress),
    cc: capture.cc.map(serializeAddress),
    bcc: capture.bcc.map(serializeAddress),
  };
}

function serializeAddress(
  address: EmailCaptureSummary["from"],
): StudioEmailAddress {
  return { address: address.address, name: address.name ?? null };
}

function stringData(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberData(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Preserves useful header names while keeping credentials out of Studio. */
function redactHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      name,
      sensitiveHeaderName.test(name) ? "[REDACTED]" : value,
    ]),
  );
}
