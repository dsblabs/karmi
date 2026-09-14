/// <reference lib="esnext.disposable" />
// Adapted from Cloudflare Codemode (MIT); see NOTICE.
export const SANDBOX_CODEC = String.raw`
    const __CODEMODE_BINARY_TAG = "__codemode_binary_v1__";
    function __bytesToBase64(bytes) {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      return btoa(binary);
    }
    function __base64ToBytes(b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    function __encodeCodemodeValue(value) {
      if (value instanceof Uint8Array) {
        return { [__CODEMODE_BINARY_TAG]: "Uint8Array", data: __bytesToBase64(value) };
      }
      if (value instanceof ArrayBuffer) {
        return { [__CODEMODE_BINARY_TAG]: "ArrayBuffer", data: __bytesToBase64(new Uint8Array(value)) };
      }
      if (ArrayBuffer.isView(value)) {
        return { [__CODEMODE_BINARY_TAG]: "ArrayBufferView", data: __bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      }
      return value;
    }
    function __decodeCodemodeValue(value) {
      if (!value || typeof value !== "object" || !(__CODEMODE_BINARY_TAG in value) || typeof value.data !== "string") return value;
      const bytes = __base64ToBytes(value.data);
      if (value[__CODEMODE_BINARY_TAG] === "ArrayBuffer") {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return bytes;
    }
    function __stringifyForCodemode(value) {
      return JSON.stringify(value, (_key, nested) => __encodeCodemodeValue(nested));
    }
    function __parseForCodemode(json) {
      return JSON.parse(json, (_key, nested) => __decodeCodemodeValue(nested));
    }
`;

export function disposeQuietly(resource: unknown): void {
  if (typeof resource !== "object" || resource === null || !(Symbol.dispose in resource)) return;
  const dispose: unknown = Reflect.get(resource, Symbol.dispose);
  if (typeof dispose !== "function") return;
  try {
    dispose.call(resource);
  } catch {
    /* Cleanup must not mask the result. */
  }
}
