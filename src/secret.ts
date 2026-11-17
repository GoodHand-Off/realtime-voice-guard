// A credential that stays out of logs: JSON.stringify, String() and
// util.inspect all print [redacted]. The value lives in an ES #private field,
// which, unlike a TypeScript `private`, is invisible to reflection.

import { inspect } from "node:util";

const REDACTED = "[redacted]";

/** Holds a key or password. Call {@link Secret.reveal} only where the value is used. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
