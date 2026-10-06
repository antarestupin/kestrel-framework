/**
 * Creates an RFC 9562 UUID v7 in Node.js and browsers using Web Crypto.
 * The timestamp orders milliseconds, not calls within a millisecond or commits.
 */
export function uuidV7(): string {
  const timestamp = Date.now();

  // Reject unsupported clocks instead of silently truncating the 48-bit epoch.
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError("UUID v7 requires a 48-bit Unix timestamp in milliseconds.");
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Store the timestamp in network byte order, preserving 74 random bits.
  view.setUint16(0, Math.floor(timestamp / 0x100000000));
  view.setUint32(2, timestamp % 0x100000000);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
