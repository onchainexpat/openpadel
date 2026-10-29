// The MCP endpoint: tools generated from the action registry, for the person behind the token.
// Each action is a pair: *_preview returns the plan and a run id, *_confirm applies that run id.
// So an assistant can never apply something different from what it showed the person.
import * as z from "zod/mini";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { both, en, isLang, type Key, type Lang, type Text } from "@kumi/i18n";
import { actions, apply, mayEverDo, plan, KumiError, type Actor, type Db } from "@kumi/core";

const toolBase = (action: string) => action.replace(/\./g, "_");
const titleOf = (action: string): Text => (`action.${action}` in en ? both(`action.${action}` as Key) : { en: action, es: action });

export async function mcpServerFor(db: Db, who: { id: string; display_name: string; locale: string; client_name: string | null }, now: () => Date): Promise<McpServer> {
  const lang: Lang = isLang(who.locale) ? who.locale : "en";
  const actor: Actor = { personId: who.id, via: `mcp:${who.client_name ?? "client"}`, lang };
  const server = new McpServer({ name: "kumi", version: "0.1.0" }, { instructions: `You act for ${who.display_name} at their padel club. Every change is two steps: call a *_preview tool, show the person the summary in their words, and only after they agree call the matching *_confirm tool with the run_id. Reply in ${lang === "es" ? "Spanish" : "English"}.` });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  const fail = (e: unknown) => {
    if (e instanceof KumiError) return { isError: true, content: [{ type: "text" as const, text: e.text[lang] }] };
    throw e;
  };

  server.registerTool("whoami", { title: lang === "es" ? "Quién soy" : "Who am I", description: "The signed-in person, their roles and the club.", annotations: { readOnlyHint: true } }, async () => {
    const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "person_role.location_id"]).where("person_id", "=", who.id).where("active", "=", true).execute();
    return text({ person: who.display_name, language: lang, roles, club });
  });

  for (const a of actions()) {
    // A tool you may never use doesn't exist for you. Undo is checked against the original change.
    const listed = a.name === "action.undo" || (await mayEverDo(db, who.id, a.name));
    if (a.system || a.name.startsWith("test.") || !listed) continue;
    const base = toolBase(a.name), title = titleOf(a.name);
    server.registerTool(`${base}_preview`, {
      title: `${title[lang]} (${lang === "es" ? "vista previa" : "preview"})`,
      description: `Preview: ${title.en}. Shows exactly what would change, who is told and how it can be undone, and returns a run_id. Nothing changes until ${base}_confirm is called with that run_id.`,
      inputSchema: a.input.shape, annotations: { readOnlyHint: true },
    }, async (args: unknown) => {
      try {
        const p = await plan(db, a.name, args, actor, { now: now() });
        return text({ run_id: p.runId, status: p.status, summary: p.plan.summary[lang], undo: p.plan.undo.kind, expires_at: p.expiresAt,
          next: p.status === "awaiting_approval" ? "This needs a staff member's approval; it will happen once they approve." : `Show the person the summary. If they agree, call ${base}_confirm with this run_id.` });
      } catch (e) { return fail(e); }
    });
    server.registerTool(`${base}_confirm`, {
      title: `${title[lang]} (${lang === "es" ? "confirmar" : "confirm"})`,
      description: `Confirm: ${title.en}. Applies a preview from ${base}_preview, by its run_id, after the person agreed. Fails if anything changed since the preview.`,
      inputSchema: { run_id: z.uuid().check(z.describe("The run_id that the preview returned")) }, annotations: { readOnlyHint: false, idempotentHint: true },
    }, async (args: { run_id: string }) => {
      try { return text({ done: true, result: await apply(db, args.run_id, actor, { now: now(), idempotencyKey: `mcp:${args.run_id}` }) }); }
      catch (e) { return fail(e); }
    });
  }
  return server;
}

export async function handleMcp(req: Request, server: McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
