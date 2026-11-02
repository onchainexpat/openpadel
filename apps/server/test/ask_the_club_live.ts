// The live check for ask the club: runs the labelled set (ask_the_club_set.ts) through each model whose key is
// set, KUMI_TYPESAFE_API_KEY (Jev) and KUMI_ANTHROPIC_API_KEY (Claude Haiku), and says how often each sent the
// right fact, handed over what needed a person, and (what matters most) sent a fact it shouldn't have. It costs
// cents and isn't part of `npm test`; with no key it does nothing.
//
//   node apps/server/test/ask_the_club_live.ts                  # every model with a key
//   ATC_OUT=jev.json node apps/server/test/ask_the_club_live.ts # also keep the answers, for --compare
//   node apps/server/test/ask_the_club_live.ts --compare jev.json haiku.json
import { readFileSync, writeFileSync } from "node:fs";
import { haikuProvider, jevProvider, makeAnswerer } from "../src/answerer.ts";
import { SET_QUESTIONS, factsIn } from "./ask_the_club_set.ts";

type Row = { text: string; want: string; got: string; confidence: number | null; ms: number; tokens: { input: number; output: number }; error?: string };
// List prices per million tokens (input, output), 2 Nov 2026: Jev $0.042 in, output free; Haiku 5.5 $0.10 in, $0.50 out.
const PRICE: Record<string, [number, number]> = { jev: [0.042, 0], haiku: [0.1, 0.5] };

if (process.argv[2] === "--compare") {
  const [a, b] = [process.argv[3]!, process.argv[4]!].map((f) => JSON.parse(readFileSync(f, "utf8")) as { model: string; rows: Row[] });
  const same = a!.rows.filter((r, n) => r.got === b!.rows[n]!.got).length;
  console.log(`${a!.model} and ${b!.model} agree on ${same} of ${a!.rows.length}`);
  a!.rows.forEach((r, n) => { if (r.got !== b!.rows[n]!.got) console.log(`  differ: "${r.text}": ${a!.model} ${r.got === r.want ? "right" : "wrong"}, ${b!.model} ${b!.rows[n]!.got === r.want ? "right" : "wrong"}`); });
  process.exit(0);
}

const models = [
  ...(process.env.KUMI_TYPESAFE_API_KEY ? [{ name: "jev", p: jevProvider(process.env.KUMI_TYPESAFE_API_KEY) }] : []),
  ...(process.env.KUMI_ANTHROPIC_API_KEY ? [{ name: "haiku", p: haikuProvider(process.env.KUMI_ANTHROPIC_API_KEY) }] : []),
];
if (!models.length) { console.log("skipped: set KUMI_TYPESAFE_API_KEY and/or KUMI_ANTHROPIC_API_KEY"); process.exit(0); }

for (const { name, p } of models) {
  const a = makeAnswerer([p])!, rows: Row[] = [];
  for (const q of SET_QUESTIONS) {
    const t0 = Date.now();
    try {
      const c = await a.decide({ text: q.text, lang: q.lang }, factsIn(q.lang));
      const d = c.detail as { ms: number; tokens: { input: number; output: number } };
      rows.push({ text: q.text, want: q.want, got: c.outcome === "fact" ? c.factId! : "staff", confidence: c.confidence, ms: d.ms, tokens: d.tokens });
    } catch (e) { rows.push({ text: q.text, want: q.want, got: "staff", confidence: null, ms: Date.now() - t0, tokens: { input: 0, output: 0 }, error: (e as Error).message }); }
  }
  const right = rows.filter((r) => r.got === r.want).length, sent = rows.filter((r) => r.got !== "staff");
  const wrongSends = sent.filter((r) => r.got !== r.want), missed = rows.filter((r) => r.want !== "staff" && r.got === "staff");
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y), tin = rows.reduce((n, r) => n + r.tokens.input, 0), tout = rows.reduce((n, r) => n + r.tokens.output, 0);
  const [pin, pout] = PRICE[name]!, cost = (tin * pin + tout * pout) / 1e6;
  console.log(`\n${name}: ${right} of ${rows.length} right; ${sent.length} answered from a fact, ${rows.length - sent.length} to the staff`);
  console.log(`  wrong facts sent: ${wrongSends.length}${wrongSends.map((r) => `\n    "${r.text}"`).join("")}`);
  console.log(`  facts it could have sent but handed over: ${missed.length}${missed.map((r) => `\n    "${r.text}"${r.confidence !== null ? ` (best ${r.confidence.toFixed(2)})` : ""}${r.error ? ` [${r.error}]` : ""}`).join("")}`);
  console.log(`  time: median ${ms[Math.floor(ms.length / 2)]} ms, slowest ${ms[ms.length - 1]} ms; tokens ${tin} in, ${tout} out; about $${cost.toFixed(5)} for the set ($${(cost / rows.length).toFixed(6)} a question)`);
  if (process.env.ATC_OUT) writeFileSync(process.env.ATC_OUT, JSON.stringify({ model: name, rows }, null, 1));
}
