// One JSON line per thing worth knowing, on stderr (journald keeps it for a local plugin). Never a token or a key, and
// never a member's number or what they wrote: the fields logged are chosen by hand (a number as its last four), and
// anything shaped like a secret is blotted out again here.

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

// The club's own (opa_, whsec_, opps_), a bearer header, Meta's access tokens (EAA...), and a token in a form or JSON field.
const SECRET = new RegExp([
  String.raw`\b(opa_|whsec_|opps_)[A-Za-z0-9_-]+`,
  String.raw`(Bearer|Basic)\s+[^\s"\\]+`,
  String.raw`\bEAA[A-Za-z0-9]{20,}`,
  String.raw`\b(access_token|verify_token|hub\.verify_token|app_secret|value)(=|\\?"\s*:\s*\\?")[^&"\\\s]+`,
].join("|"), "g");
export const redact = (s: string) => s.replace(SECRET, (m, _a, _b, field: string | undefined, sep: string | undefined) => (field ? `${field}${sep}[hidden]` : "[hidden]"));
/** A member's number as the log may show it: its last four. */
export const tail = (phone: string) => `…${phone.slice(-4)}`;

export const jsonLog: Log = (level, msg, fields = {}) => {
  process.stderr.write(redact(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields })) + "\n");
};
export const quietLog: Log = () => {};
