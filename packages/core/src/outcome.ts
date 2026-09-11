import { KarmiError, SpecInvalidError, type KarmiErrorCode } from "./errors";
import type { ValidationFailure } from "./validate";

/**
 * Workers RPC keeps only an Error's message, so every Durable Object method reports failure as data and
 * the handle rethrows it as a `KarmiError` (or `SpecInvalidError` when `result` is present).
 */
export type Outcome<T> =
  { ok: true; value: T } | { ok: false; code: KarmiErrorCode; message: string; result?: ValidationFailure };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = (error: KarmiError): Outcome<never> => ({ ok: false, code: error.code, message: error.message });

export async function unwrap<T>(outcome: Promise<Outcome<T>>): Promise<T> {
  const result = await outcome;
  if (result.ok) return result.value;
  if (result.result) throw new SpecInvalidError(result.result);
  throw new KarmiError(result.code, result.message);
}

/**
 * The stub type for one of karmi's Durable Objects. Workers' own `DurableObjectStub<T>` erases results
 * that carry `unknown` (Event payloads, channelRefs, validation details) to `never`; the methods declare
 * exactly what they return, so the stub is typed from them.
 */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export function remote<T>(namespace: DurableObjectNamespace, name: string): Remote<T> {
  // eslint-disable-next-line no-restricted-syntax -- the one boundary cast to the stub type the comment above explains.
  return namespace.get(namespace.idFromName(name)) as unknown as Remote<T>;
}
