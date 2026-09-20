import { DurableObject } from "cloudflare:workers";

/** The stored state of one scenario: its sample data and the count of resets. */
export interface ScenarioState {
  /** The sample data as JSON text, or undefined while the scenario still has its starting data. */
  data: string | undefined;
  /** The count of resets. The Thread id of the scenario contains it, so each reset starts a new Thread. */
  generation: number;
}

/**
 * The sample system of one scenario in one Scope. Each scenario owns one instance, thus a reset of one scenario
 * cannot change the data of a different one. It stores sample data only, never a credential.
 */
export class SampleDataDO extends DurableObject {
  /** Returns the stored state. */
  async read(): Promise<ScenarioState> {
    return {
      data: await this.ctx.storage.get<string>("data"),
      generation: (await this.ctx.storage.get<number>("generation")) ?? 0,
    };
  }

  /** Replaces the sample data with this JSON text. */
  async write(data: string): Promise<void> {
    await this.ctx.storage.put("data", data);
  }

  /** Deletes the sample data and returns the next generation. */
  async reset(): Promise<number> {
    const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
    await this.ctx.storage.delete("data");
    await this.ctx.storage.put("generation", generation);
    return generation;
  }
}

/** Returns the sample system of `scenario` in `scope`. */
export function sampleData(
  namespace: DurableObjectNamespace<SampleDataDO>,
  scope: string,
  scenario: string,
): DurableObjectStub<SampleDataDO> {
  return namespace.get(namespace.idFromName(`${scope}:${scenario}`));
}
