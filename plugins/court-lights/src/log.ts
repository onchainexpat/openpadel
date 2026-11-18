// One JSON line per thing worth knowing, on stderr (journald keeps it for a local plugin). Never a token or a key: the
// fields logged are chosen by hand, and anything shaped like one is blotted out again here in case.

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

const SECRET = /\b(opa_|whsec_|opps_)[A-Za-z0-9_-]+|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
export const redact = (s: string) => s.replace(SECRET, "[hidden]");

export const jsonLog: Log = (level, msg, fields = {}) => {
  process.stderr.write(redact(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields })) + "\n");
};
export const quietLog: Log = () => {};
