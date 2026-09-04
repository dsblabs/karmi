/** Every error karmi throws carries a stable, dotted code a caller can switch on. */
export class KarmiError extends Error {
  override readonly name = "KarmiError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
