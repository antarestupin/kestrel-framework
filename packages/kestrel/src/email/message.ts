import type {
  EmailAddress,
  EmailAddressInput,
  EmailAttachment,
  EmailMessage,
  EmailMessageInput,
} from "./types.js";

const maximumAddressLength = 320;
const maximumDisplayNameLength = 256;
const maximumFilenameLength = 255;
const maximumSubjectLength = 998;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Validates and detaches caller-owned data before crossing the driver boundary. */
export function normalizeEmailMessage(input: EmailMessageInput): EmailMessage {
  if (input === null || typeof input !== "object") {
    throw new TypeError("An email message must be an object.");
  }

  const subject = normalizeText(input.subject, "subject", maximumSubjectLength);
  const text = normalizeOptionalBody(input.text, "text");
  const html = normalizeOptionalBody(input.html, "html");

  if (text === undefined && html === undefined) {
    throw new TypeError("An email message requires a text or HTML body.");
  }

  return Object.freeze({
    from: normalizeAddress(input.from, "from"),
    to: normalizeAddresses(input.to, "to", true),
    cc: normalizeAddresses(input.cc, "cc", false),
    bcc: normalizeAddresses(input.bcc, "bcc", false),
    replyTo: normalizeAddresses(input.replyTo, "replyTo", false),
    subject,
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    ...(input.headers === undefined
      ? {}
      : { headers: normalizeHeaders(input.headers) }),
    attachments: normalizeAttachments(input.attachments ?? []),
  });
}

function normalizeAddresses(
  input: EmailAddressInput | readonly EmailAddressInput[] | undefined,
  field: string,
  required: boolean,
): readonly EmailAddress[] {
  const values = input === undefined
    ? []
    : Array.isArray(input) ? input : [input as EmailAddressInput];

  if (required && values.length === 0) {
    throw new TypeError(`Email field "${field}" requires at least one address.`);
  }

  return Object.freeze(values.map((value) => normalizeAddress(value, field)));
}

function normalizeAddress(input: EmailAddressInput, field: string): EmailAddress {
  const address = typeof input === "string" ? input : input?.address;
  const name = typeof input === "string" ? undefined : input?.name;
  const normalizedAddress = normalizeText(
    address,
    `${field} address`,
    maximumAddressLength,
  );

  // Full RFC mailbox validation belongs to the transport. This boundary only
  // rejects whitespace, control characters and structurally impossible input.
  if (
    /[\s\u0000-\u001f\u007f]/u.test(normalizedAddress)
    || normalizedAddress.startsWith("@")
    || normalizedAddress.endsWith("@")
    || normalizedAddress.split("@").length !== 2
  ) {
    throw new TypeError(`Email field "${field}" contains an invalid address.`);
  }

  const normalizedName = name === undefined
    ? undefined
    : normalizeText(name, `${field} name`, maximumDisplayNameLength);

  return Object.freeze({
    address: normalizedAddress,
    ...(normalizedName === undefined ? {} : { name: normalizedName }),
  });
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("Email headers must be a record of strings.");
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (!headerNamePattern.test(name)) {
        throw new TypeError("An email header has an invalid name.");
      }
      if (typeof value !== "string" || /[\r\n]/u.test(value)) {
        throw new TypeError(`Email header "${name}" has an invalid value.`);
      }

      return [name, value];
    }),
  ));
}

function normalizeAttachments(
  attachments: readonly EmailAttachment[],
): readonly EmailAttachment[] {
  if (!Array.isArray(attachments)) {
    throw new TypeError("Email attachments must be an array.");
  }

  return Object.freeze(attachments.map((attachment) => {
    if (attachment === null || typeof attachment !== "object") {
      throw new TypeError("An email attachment must be an object.");
    }

    const content = attachment.content;
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      throw new TypeError("Email attachment content must be text or bytes.");
    }

    return Object.freeze({
      filename: normalizeText(
        attachment.filename,
        "attachment filename",
        maximumFilenameLength,
      ),
      content: typeof content === "string" ? content : new Uint8Array(content),
      ...(attachment.contentType === undefined
        ? {}
        : {
            contentType: normalizeText(
              attachment.contentType,
              "attachment content type",
              255,
            ),
          }),
      ...(attachment.disposition === undefined
        ? {}
        : { disposition: attachment.disposition }),
      ...(attachment.contentId === undefined
        ? {}
        : {
            contentId: normalizeText(
              attachment.contentId,
              "attachment content ID",
              998,
            ),
          }),
    });
  }));
}

function normalizeOptionalBody(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Email field "${field}" must be a non-empty string.`);
  }

  return value;
}

function normalizeText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`Email field "${field}" must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TypeError(`Email field "${field}" has an invalid length.`);
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new TypeError(`Email field "${field}" cannot contain a line break.`);
  }

  return normalized;
}
