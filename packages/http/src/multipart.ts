import { mediaKind, type MediaRef, type Part, type Thread, type ThreadUploads, type TurnInput } from "@karmi/core";
import { HttpError } from "./errors";
import { parseJsonText, type TurnRequest } from "./decode";

// A multipart Turn carries text fields and files. Each file is stored under the Thread through the public
// `uploads` API and becomes a media Part, so the resulting `TurnInput` is the same one a JSON client sends.

const FIELDS = new Set(["text", "skill", "channelRef", "steer"]);

function partOf(ref: MediaRef): Part {
  const kind = mediaKind(ref.mimeType);
  const type = kind === "image" || kind === "video" || kind === "audio" ? kind : "file";
  return { type, media: ref, mimeType: ref.mimeType, ...(ref.name !== undefined && { name: ref.name }) };
}

/**
 * Reads a `multipart/form-data` Turn: every `text` field becomes a text Part and every file is uploaded to
 * the Thread and becomes a media Part, in the order posted. `skill`, `channelRef` (JSON) and `steer`
 * (`"true"`) are read as on a JSON Turn. Throws a 400 `HttpError` when no Part results. Each ref is pushed
 * onto `minted` as it is uploaded, so the caller can discard them all when it abandons the Turn.
 */
export async function readMultipartTurn(request: Request, thread: Thread, minted: MediaRef[]): Promise<TurnRequest> {
  const form = await request.formData();
  const parts: Part[] = [];
  const fields: { skill?: string; channelRef?: unknown; steer?: boolean } = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") {
      const ref = await thread.uploads.put(value.stream(), { mimeType: value.type, name: value.name });
      minted.push(ref);
      parts.push(partOf(ref));
    } else if (name === "text") parts.push({ type: "text", text: value });
    else if (name === "skill") fields.skill = value;
    else if (name === "steer") fields.steer = value === "true";
    else if (name === "channelRef") fields.channelRef = parseJsonText(value, "channelRef field");
    else if (!FIELDS.has(name)) throw new HttpError(400, "http.badRequest", `Unknown form field "${name}".`);
  }
  if (parts.length === 0) throw new HttpError(400, "http.badRequest", "A multipart Turn needs a text field or a file.");
  const input: TurnInput = {
    kind: "message",
    parts,
    ...(fields.skill !== undefined && { skill: fields.skill }),
    ...(fields.channelRef !== undefined && { channelRef: fields.channelRef }),
  };
  return { input, steer: fields.steer === true };
}

/**
 * Deletes every ref uploaded for a Turn that was never accepted. It never throws: a discard that fails leaves
 * an object the Thread's own cleanup still reclaims, and the caller has an error of its own to report.
 */
export async function discardMinted(uploads: Pick<ThreadUploads, "delete">, minted: MediaRef[]): Promise<void> {
  await Promise.all(minted.map((ref) => uploads.delete(ref).catch(() => {})));
}
