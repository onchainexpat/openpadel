import { both, type Key, type Params, type Text } from "@kumi/i18n";

/** A failure a person can act on, worded in English and Spanish. */
export class KumiError extends Error {
  readonly code: Key;
  readonly params: Params;
  readonly status: number;
  readonly text: Text;
  constructor(code: Key, params: Params = {}, status = 409) {
    const text = both(code, params);
    super(text.en);
    this.code = code; this.params = params; this.status = status; this.text = text;
  }
}
