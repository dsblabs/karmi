import { CloudflareContainerSandbox } from "./container-sandbox";
import { decodeContainerRun, type ContainerDriver, type ContainerLimits } from "./container-types";
import { DEFAULT_MEDIA_BYTES, putMedia } from "./media";
import type { ScopeConfigDocument } from "./scope-config";
import type { ThreadEventData } from "./thread-events";
import { mediaKeyScope } from "./keys";

/** The Thread resources used by a Workspace without passing any credentials into its process. */
export interface WorkspaceHost {
  sql: SqlStorage;
  scope: string;
  threadId: string;
  bucket: R2Bucket | undefined;
  media: ScopeConfigDocument["media"];
  now(): number;
  append(event: ThreadEventData): void;
  schedule(): void;
}
/** Connects a Sandbox to the Thread's persisted process record and Scope media store. */
export function workspaceSandbox(
  host: WorkspaceHost,
  driver: ContainerDriver,
  limits: ContainerLimits,
  allow: string[],
): CloudflareContainerSandbox {
  return new CloudflareContainerSandbox(
    driver,
    {
      now: host.now,
      read: () => {
        const row = host.sql.exec<{ json: string }>("SELECT json FROM container_run WHERE id = 1").toArray()[0];
        return row ? decodeContainerRun(row.json) : undefined;
      },
      save: (run) => {
        host.sql.exec(
          "INSERT INTO container_run (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
          JSON.stringify(run),
        );
        host.schedule();
      },
      clear: () => {
        host.sql.exec("DELETE FROM container_run");
      },
      progress: (jobId, stdout) => {
        const pending = host.sql
          .exec("SELECT seq FROM events WHERE type = 'job.started' AND json_extract(json, '$.jobId') = ?", jobId)
          .toArray();
        if (pending.length) host.append({ type: "job.progress", jobId, content: [{ type: "text", text: stdout }] });
      },
      load: async (ref) => {
        if (mediaKeyScope(ref.key) !== host.scope) throw new Error("Script files must reference media in this Scope.");
        const object = await host.bucket?.get(ref.key);
        if (!object) throw new Error("Script input media is unavailable.");
        if (object.size > (host.media?.maxBytes ?? DEFAULT_MEDIA_BYTES))
          throw new Error("Script input exceeds Scope media.maxBytes.");
        return new Uint8Array(await object.arrayBuffer());
      },
      store: (name, bytes) =>
        putMedia(
          {
            bucket: host.bucket,
            scope: host.scope,
            threadId: host.threadId,
            ...(host.media && { limits: host.media }),
          },
          bytes.slice().buffer,
          { name },
        ),
      maxBytes: host.media?.maxBytes ?? DEFAULT_MEDIA_BYTES,
    },
    limits,
    allow,
  );
}
