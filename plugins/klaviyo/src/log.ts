// One JSON line per thing worth knowing, on stderr (journald keeps it for a local plugin). Never a token, a key or a
// member's email: the fields logged are chosen by hand (ids and counts), and anything shaped like a secret or an email
// is blotted out again here in case.

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

// The club's own (opa_, whsec_, opps_), a bearer or Klaviyo key header, a Klaviyo private key (pk_...), a JWT, and an email.
const SECRET = new RegExp([
  String.raw`\b(opa_|whsec_|opps_|pk_)[A-Za-z0-9_-]+`,
  String.raw`(Bearer|Klaviyo-API-Key)\s+[^\s"\\]+`,
  String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*`,
  String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}`,
].join("|"), "gu");
export const redact = (s: string) => s.replace(SECRET, "[hidden]");

export const jsonLog: Log = (level, msg, fields = {}) => {
  process.stderr.write(redact(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields })) + "\n");
};
export const quietLog: Log = () => {};
