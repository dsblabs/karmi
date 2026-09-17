import { CloudflareContainerSandbox, type ContainerHost, type ContainerLimits } from "@karmi/core/sandbox";
import { LocalContainerDriver } from "./local-driver";
export { LocalContainerDriver } from "./local-driver";

/** Runs trusted shell and Python Scripts without Docker; it does not isolate host files or enforce egress. */
export class LocalProcessSandbox extends CloudflareContainerSandbox {
  /** The security limitation callers must display when offering local execution. */
  readonly security = "Trusted local execution: host filesystem accessible; egress not enforced.";
  constructor(host: ContainerHost, limits: ContainerLimits, allow: string[] = []) {
    super(new LocalContainerDriver(), host, limits, allow);
  }
}
