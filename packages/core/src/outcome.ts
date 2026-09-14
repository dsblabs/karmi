import { KarmiError, SpecInvalidError, type KarmiErrorCode } from "./errors";
import type { ValidationFailure } from "./validate";

/**
 * The result a Durable Object method returns: the value, or a failure as data. Workers RPC keeps only an
 * Error's message, so failures travel as data and `unwrap` rethrows them on the caller's side as a
 * `KarmiError`, or a `SpecInvalidError` when `result` is present.
 */
export type Outcome<T> =
  { ok: true; value: T } | { ok: false; code: KarmiErrorCode; message: string; result?: ValidationFailure };

/** Wraps `value` as a successful Outcome. */
export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
/** Wraps `error` as a failed Outcome, keeping its code and message. */
export const fail = (error: KarmiError): Outcome<never> => ({ ok: false, code: error.code, message: error.message });

/** Awaits `outcome` and returns its value, or throws the error it carries. */
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

/** The stub for the Durable Object called `name` in `namespace`, typed by the methods of `T`. */
export function remote<T>(namespace: DurableObjectNamespace, name: string): Remote<T> {
  // The stub type is the only boundary cast in the module. See the `Remote` doc for why it is safe.
  // eslint-disable-next-line no-restricted-syntax
  return namespace.get(namespace.idFromName(name)) as unknown as Remote<T>;
}
