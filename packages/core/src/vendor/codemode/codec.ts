// Adapted from Cloudflare Codemode (MIT); see NOTICE.
// Methods keep the factory self-contained even when a bundler preserves function names with helpers.
function codec() {
  const tag = "__codemode_binary_v1__";
  const wire = {
    bytesToBase64(bytes: Uint8Array): string {
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.byteLength)));
      return btoa(binary);
    },
    base64ToBytes(b64: string): Uint8Array {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },
    encode(value: unknown): unknown {
      if (value instanceof Uint8Array) return { [tag]: "Uint8Array", data: wire.bytesToBase64(value) };
      if (value instanceof ArrayBuffer)
        return { [tag]: "ArrayBuffer", data: wire.bytesToBase64(new Uint8Array(value)) };
      if (ArrayBuffer.isView(value))
        return {
          [tag]: "ArrayBufferView",
          data: wire.bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
      return value;
    },
    decode(value: unknown): unknown {
      if (
        !value ||
        typeof value !== "object" ||
        !(tag in value) ||
        !("data" in value) ||
        typeof value.data !== "string"
      )
        return value;
      const bytes = wire.base64ToBytes(value.data);
      return value[tag] === "ArrayBuffer"
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes;
    },
    stringifyForCodemode(value: unknown): string {
      return JSON.stringify(value, (_key, nested) => wire.encode(nested));
    },
    parseForCodemode(json: string): unknown {
      return JSON.parse(json, (_key, nested) => wire.decode(nested));
    },
  };
  return wire;
}
export const { stringifyForCodemode, parseForCodemode } = codec();
export const SANDBOX_CODEC = `const { stringifyForCodemode: __stringifyForCodemode, parseForCodemode: __parseForCodemode } = (${codec.toString()})();`;
