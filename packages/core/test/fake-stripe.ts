// A stand-in for api.stripe.com with Connect: accounts, payment intents kept per account, refunds,
// and every call recorded with the account it was made on.
export function fakeStripe() {
  const accounts = new Map<string, { charges_enabled: boolean; details_submitted: boolean; key: string }>();
  const intents = new Map<string, { account: string | null; status: string; amount: number; key: string }>();
  const refunds: { id: string; account: string | null; payment_intent: string; amount: number }[] = [];
  const calls: { method: string; path: string; account: string | null; key: string | null; body: URLSearchParams }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(url), h = init?.headers as Record<string, string>, body = new URLSearchParams(String(init?.body ?? ""));
    const account = h["stripe-account"] ?? null, key = h["idempotency-key"] ?? null, method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname, account, key, body });
    if (method === "POST" && u.pathname === "/v1/accounts") {
      const known = [...accounts].find(([, a]) => a.key === key);
      const id = known?.[0] ?? `acct_${accounts.size + 1}TEST`;
      if (!known) accounts.set(id, { charges_enabled: false, details_submitted: false, key: key ?? "" });
      return Response.json({ id, type: "standard", ...accounts.get(id) });
    }
    if (method === "POST" && u.pathname === "/v1/account_links") return Response.json({ url: `https://connect.stripe.com/setup/s/${body.get("account")}`, expires_at: 0 });
    const acct = u.pathname.match(/^\/v1\/accounts\/(.+)$/);
    if (acct) { const a = accounts.get(acct[1]!); return a ? Response.json({ id: acct[1], ...a, settings: { dashboard: { display_name: "Kestrel Padel" } } }) : Response.json({ error: { message: "no account" } }, { status: 404 }); }
    if (method === "POST" && u.pathname === "/v1/payment_intents") {
      const known = [...intents].find(([, i]) => i.key === key && i.account === account);
      const id = known?.[0] ?? `pi_${intents.size + 1}`;
      if (!known) intents.set(id, { account, status: "requires_payment_method", amount: Number(body.get("amount")), key: key ?? "" });
      return Response.json({ id, client_secret: `${id}_secret`, status: intents.get(id)!.status });
    }
    const pi = u.pathname.match(/^\/v1\/payment_intents\/(.+)$/);
    if (pi) {
      const it = intents.get(pi[1]!);
      // An intent only exists on the account it was made on.
      if (!it || it.account !== account) return Response.json({ error: { message: "No such payment_intent", code: "resource_missing" } }, { status: 404 });
      return Response.json({ id: pi[1], client_secret: `${pi[1]}_secret`, status: it.status });
    }
    if (method === "POST" && u.pathname === "/v1/refunds") {
      const it = intents.get(body.get("payment_intent") ?? "");
      if (!it || it.account !== account) return Response.json({ error: { message: "No such payment_intent", code: "resource_missing" } }, { status: 404 });
      const id = `re_${refunds.length + 1}`;
      refunds.push({ id, account, payment_intent: body.get("payment_intent")!, amount: Number(body.get("amount")) });
      return Response.json({ id, status: "succeeded" });
    }
    return Response.json({ error: { message: `unexpected ${method} ${u.pathname}` } }, { status: 400 });
  };
  return { fetch, accounts, intents, refunds, calls };
}
