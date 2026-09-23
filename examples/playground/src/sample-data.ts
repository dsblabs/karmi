import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

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

  /**
   * Adds one item to the sample data, which is a JSON list. It adds nothing when the list has an item with the
   * same `id`. One call is atomic, thus two callers at the same time lose no item.
   */
  async append(id: string, item: string): Promise<void> {
    const list = decodeSample(itemList, [], await this.ctx.storage.get<string>("data"));
    if (list.some((entry) => entry.id === id)) return;
    const added: unknown = JSON.parse(item);
    await this.ctx.storage.put("data", JSON.stringify([...list, added]));
  }

  /**
   * Sets one field of the sample data, which is a JSON object, to this JSON text. One call is atomic, thus it
   * loses no change that a different caller made to a different field at the same time.
   */
  async set(field: string, value: string): Promise<void> {
    const data = decodeSample(fieldObject, {}, await this.ctx.storage.get<string>("data"));
    const next: unknown = JSON.parse(value);
    await this.ctx.storage.put("data", JSON.stringify({ ...data, [field]: next }));
  }

  /**
   * Adds one item to the list in one field of the sample data, which is a JSON object, and keeps only the last
   * `keep` items. One call is atomic, thus two callers at the same time lose no item.
   */
  async push(field: string, item: string, keep: number): Promise<void> {
    const data = decodeSample(fieldObject, {}, await this.ctx.storage.get<string>("data"));
    const current = data[field];
    const list: unknown[] = Array.isArray(current) ? current : [];
    const added: unknown = JSON.parse(item);
    await this.ctx.storage.put("data", JSON.stringify({ ...data, [field]: [...list, added].slice(-keep) }));
  }

  /** Deletes the sample data and returns the next generation. */
  async reset(): Promise<number> {
    const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
    await this.ctx.storage.delete("data");
    await this.ctx.storage.put("generation", generation);
    return generation;
  }
}

// The list that `append` keeps. It checks only the id, because the scenario decodes each other part of an item.
const itemList = z.array(z.looseObject({ id: z.string() }));

// The object that `set` and `push` change. They check only the shape, because the scenario decodes each field.
const fieldObject = z.record(z.string(), z.unknown());

/**
 * Decodes the stored sample data of one scenario with its schema. Data that is absent or not valid gives the
 * starting value, thus a scenario always shows data that its page can render.
 */
export function decodeSample<Schema extends z.ZodType>(
  schema: Schema,
  starting: z.infer<Schema>,
  data: string | undefined,
): z.infer<Schema> {
  if (data === undefined) return starting;
  try {
    const parsed = schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : starting;
  } catch {
    return starting;
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
