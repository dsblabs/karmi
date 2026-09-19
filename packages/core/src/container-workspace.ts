import { CloudflareContainerSandbox } from "./container-sandbox";
import type { ContainerDriver, ContainerLimits, ContainerRun } from "./container-types";
import { DEFAULT_MEDIA_BYTES, putMedia } from "./media";
import type { ScopeConfigDocument } from "./scope-config";
import type { ThreadEventData } from "./thread-events";
import { threadMayRead } from "./keys";

/** The Thread resources used by a Workspace without passing any credentials into its process. */
export interface WorkspaceHost {
  readRun(): ContainerRun | undefined;
  saveRun(run: ContainerRun): void;
  clearRun(): void;
  hasStartedJob(jobId: string): boolean;
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
      read: host.readRun,
      save: (run) => {
        host.saveRun(run);
        host.schedule();
      },
      clear: () => {
        host.clearRun();
      },
      progress: (jobId, stdout) => {
        if (host.hasStartedJob(jobId))
          host.append({ type: "job.progress", jobId, content: [{ type: "text", text: stdout }] });
      },
      load: async (ref) => {
        if (!threadMayRead(ref.key, host.scope, host.threadId))
          throw new Error("Script files must reference media of this Thread.");
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
