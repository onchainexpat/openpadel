// One JSON line per thing worth knowing, on stderr (journald keeps it for a local plugin). Never a token, a key or an
// authorization code: the fields logged are chosen by hand, and anything shaped like one is blotted out again here.

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

// The club's own (opa_, whsec_, opps_), a bearer or basic header, a JWT (Xero's and Intuit's access tokens), and a
// refresh token or code in a form body or a JSON field.
const SECRET = new RegExp([
  String.raw`\b(opa_|whsec_|opps_)[A-Za-z0-9_-]+`,
  String.raw`(Bearer|Basic)\s+[^\s"\\]+`,
  String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*`,
  String.raw`\b(refresh_token|access_token|code|code_verifier|client_secret|value)(=|\\?"\s*:\s*\\?")[^&"\\\s]+`,
].join("|"), "g");
export const redact = (s: string) => s.replace(SECRET, (m, _a, _b, _c, field: string | undefined, sep: string | undefined) => (field ? `${field}${sep}[hidden]` : "[hidden]"));

export const jsonLog: Log = (level, msg, fields = {}) => {
  process.stderr.write(redact(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields })) + "\n");
};
export const quietLog: Log = () => {};
