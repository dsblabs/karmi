// Adapted from Cloudflare Codemode (MIT); see NOTICE.
export const BINARY_TAG = "__codemode_binary_v1__";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeCodemodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BINARY_TAG]: "Uint8Array", data: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return {
      [BINARY_TAG]: "ArrayBuffer",
      data: bytesToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value;
    return {
      [BINARY_TAG]: "ArrayBufferView",
      data: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }
  return value;
}

export function decodeCodemodeValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !(BINARY_TAG in value)) {
    return value;
  }
  if (!("data" in value) || typeof value.data !== "string") return value;
  const encoded = value;
  const bytes = base64ToBytes(value.data);
  if (encoded[BINARY_TAG] === "ArrayBuffer") {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes;
}

export function stringifyForCodemode(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => encodeCodemodeValue(nested));
}

export function parseForCodemode(json: string): unknown {
  return JSON.parse(json, (_key, nested) => decodeCodemodeValue(nested));
}
