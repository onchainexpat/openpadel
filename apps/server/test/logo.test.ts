// The club's logo (core logo.ts, club.set_logo, manifest.ts): an SVG is refused unless it's only shapes, every file is
// drawn as a PNG on the server and only PNGs made from that are served, the logo sits on the club's colour only where
// it stands out there (else on a tile), every icon and start screen is drawn again when it changes, and it can be
// undone or taken off, which brings the drawn mark back. The logos here are made up for these tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { encodePng, KumiError, logoKind, logoTile, readLogo, run, runAsSystem, svgProblem, svgText, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { setupClub, readClubFile } from "../src/setup.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

/** A made-up mark: a ball with a curved seam, in one colour. */
const ball = (ink: string, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${extra}<circle cx="100" cy="100" r="70" fill="none" stroke="${ink}" stroke-width="16"/><path d="M48 60 C 100 90, 100 110, 48 140 M152 60 C 100 90, 100 110, 152 140" fill="none" stroke="${ink}" stroke-width="12"/></svg>`;
const LIGHT = ball("#ffffff"), DARK = ball("#1a1a1a");
/** A made-up logo with its own background: a navy square with a white disc, as a JPEG. */
const BACKED_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABQAFADASIAAhEBAxEB/8QAGwABAAIDAQEAAAAAAAAAAAAAAAUIAgcJAwT/xAAyEAABAwQABQIDBgcAAAAAAAABAAIDBAUGEQcIEiFRMWEiQbETFSNxssEyQlKBgoOR/8QAGQEBAAMBAQAAAAAAAAAAAAAAAAQFBgEC/8QAHxEAAgMAAgMBAQAAAAAAAAAAAAECAxESMQQFIUGh/9oADAMBAAIRAxEAPwCvSIi3RVBERAEREAREQBERAEREB7UdNUVtXDR0cEtRUzvbHFFEwufI8nQa0DuST20rVcHeV6kZSw3biNI+ad+nNtNPL0sYPEsje5PswgDX8RTkn4bU7KCTiNdoA+eR74LS1w7MYNtklHuTtg8AO8q0CofYewkpOqt5nbJdNKzlIgsew7FMeYxtjxu028saGh8FIxrzry7Wyfcna+m943j18Z0XqxWu5N8VdIyX9QKlEVLzlu79JOLorvxX5YMeutJNX4LIbNcWjqFHI9z6aY+ATt0ZPnZHy0PVVGyGzXTH71VWa9UU1FX0r+iaGUaLT9CCNEEdiCCNgrqCtE84HDanybCZcut9OBebLEXyOaO89KNl7T7s7vB8Bw+at/A9jNSVdj1P9I9tKzYlJURFoSGEREB0z4e2ZmP4JYrI2NrDRW+GF4aNbeGDqP5l2yfcqdUXh90be8Ss96b6V9DDUj/Ngd+6lFh57ye9louvgREXk6FhUQxVFPJTzxslhlYWSMeNtc0jRBHzBCzQkAEk6A+aA5gZPbH2bJbpZ5Dt9BWS0zvzY8tP0UcpbM7oL3mN6vLewr7hPVD/AGSOd+6iVuI7xWlWwiIvRwuRyVcQae64k/Ba+drbjauqSjDj3mpnO2QPJY4n+zm69CrELl9jt5ueP3ukvVmrJKOvpJBJDNGe7T9CCNgg9iCQexVy+DvMhjGTUsNvy6aDH7yNNMkh6aSc+WvJ/DPr2edeCVnvY+BJTdla1PsmU2rOLN7IsKeaGogZPTyxzQyNDmSMcHNcD6EEdiFmSACSdAepVMSQtQ81XEGnw3hvVW2nnb983qN9LTRg/EyMjUsvsA06B/qcPB04r8wGFYbSTU9trIcgvOtR01HIHRMd5kkG2gDwNu9h6qlee5dfM2yaoyDIKr7erm+FrWjUcLBvpjY3+Vo39Sdkkm18DwJ2SU5rIr+ke21JYuyBREWlIQREQBERASNmvt7s0hks94uNuefV1JUviP8A1pC9b1k2SXodN5yC7XIeKuskl/USolF54x3c+ndYREXo4EREB//Z", "base64");
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

/** A PNG's size and one pixel as #rrggbb plus its alpha, undoing each row's filter (PNG's five). */
function pixel(png: Buffer, x: number, y: number) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), ch = png[25] === 6 ? 4 : 3, len = w * ch;
  let o = 8; const idat: Buffer[] = [];
  while (o < png.length) { const n = png.readUInt32BE(o), type = png.toString("latin1", o + 4, o + 8); if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + n)); o += 12 + n; }
  const raw = inflateSync(Buffer.concat(idat)), rows: Buffer[] = [];
  for (let r = 0; r <= y; r++) {
    const f = raw[r * (len + 1)]!, src = raw.subarray(r * (len + 1) + 1, (r + 1) * (len + 1)), out = Buffer.alloc(len), up = rows[r - 1];
    for (let i = 0; i < len; i++) {
      const a = i >= ch ? out[i - ch]! : 0, b = up ? up[i]! : 0, c = up && i >= ch ? up[i - ch]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[i] = (src[i]! + pred) & 255;
    }
    rows.push(out);
  }
  const row = rows[y]!, at = x * ch;
  return { w, h, rgb: `#${[row[at]!, row[at + 1]!, row[at + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`, a: ch === 4 ? row[at + 3]! : 255 };
}
const refused = async (file: string | Buffer, key: string) => {
  await assert.rejects(readLogo(Buffer.from(file)), (e: unknown) => e instanceof KumiError && e.code === key, `${key}: ${String(file).slice(0, 80)}`);
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "system" };
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
  await run(db, "club.update", { brand_colour: "#F5C518" }, owner);   // a light yellow
});
after(async () => drop());

test("hostile SVGs are refused: scripts, embedded pages, handlers, outside links, imports, entities", async () => {
  const svg = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"${attrs}>${inner}<rect width="10" height="10"/></svg>`;
  const hostile = [
    svg("<script>alert(1)</script>"),
    svg('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'),
    svg("", ' onload="alert(1)"'),
    svg('<rect width="1" height="1" onclick="alert(1)"/>'),
    svg('<image href="https://tracker.example.test/x.png" width="1" height="1"/>'),
    svg('<image xlink:href="file:///etc/passwd" width="1" height="1"/>'),
    svg('<use href="other.svg#a"/>'),
    svg('<image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/>'),
    svg('<image href="java&#x09;script:alert(1)" width="1" height="1"/>'),
    svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'),
    svg('<rect width="1" height="1" style="fill:url(https://x.example.test/p.svg#g)"/>'),
    svg("<style>@import url(https://x.example.test/a.css);</style>"),
    svg('<set attributeName="href" to="javascript:alert(1)"/>'),
    svg('<animate attributeName="fill" to="red"/>'),
    svg('<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>'),
    svg('<h:img xmlns:h="http://www.w3.org/1999/xhtml" src="x"/>'),
    // A ">" in a quoted value doesn't hide the link after it.
    svg('<image title=">" href="https://x.example.test/a.png" width="1" height="1"/>'),
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg">&b;</svg>',
    '<?xml version="1.0"?><?xml-stylesheet href="https://x.example.test/a.css"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    svg("<!-- a comment can't hide anything --><iframe src=\"https://x.example.test\"/>"),
  ];
  for (const h of hostile) {
    assert.ok(svgProblem(svgText(Buffer.from(h))) !== null, `refused: ${h}`);
    assert.notEqual(svgProblem(svgText(Buffer.from(h))), "text");
    await refused(h, "error.logo_svg_unsafe");
  }
  // A small file can hold a picture that says it's huge: held to a picture's own limits.
  const huge = Buffer.from(encodePng(1, 1, new Uint8Array(4))); huge.writeUInt32BE(20000, 16); huge.writeUInt32BE(20000, 20);
  await refused(svg(`<image href="data:image/png;base64,${huge.toString("base64")}" width="10" height="10"/>`), "error.logo_svg_unsafe");
  // Text is refused with its own reason: it would draw differently, or not at all, without the font.
  await refused(svg('<text x="1" y="8">K</text>'), "error.logo_svg_text");
  // What editors write is fine: a doctype without entities, their own notes, gradients and clip paths within the file.
  const fine = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'
    + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">'
    + '<sodipodi:namedview id="v"/><metadata><title>made up</title></metadata><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ccc"/></linearGradient>'
    + '<clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath></defs><g clip-path="url(#c)"><rect width="100" height="100" style="fill:url(\'#g\')"/></g><use xlink:href="#c"/></svg>';
  assert.equal(svgProblem(svgText(Buffer.from(fine))), null);
  assert.ok((await readLogo(Buffer.from(fine))).width > 0);
});

test("files: SVG, PNG and JPEG only, under 1 MB and a sensible size; kept as a trimmed PNG with its look read", async () => {
  await refused(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "error.logo_type");
  await refused("<html><script>alert(1)</script></html>", "error.logo_type");
  await refused(Buffer.alloc(1_000_001, 0x20), "error.logo_too_big");
  await refused(encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255)), "error.logo_px");
  await refused(encodePng(40, 40, new Uint8Array(40 * 40 * 4)), "error.logo_empty");
  await refused('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', "error.logo_empty");
  assert.equal(logoKind(Buffer.from(LIGHT)), "svg"); assert.equal(logoKind(BACKED_JPEG), "jpeg");

  const light = await readLogo(Buffer.from(LIGHT)), dark = await readLogo(Buffer.from(DARK));
  assert.equal(light.png.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(Math.max(light.width, light.height), 1024, "drawn to the size kept");
  assert.ok(Math.abs(light.width - light.height) < 8, "its empty margin trimmed: the ball is as wide as it is high");
  assert.equal(pixel(light.png, 0, 0).a, 0, "transparent round the logo");
  assert.deepEqual([light.seems_for, light.backed], ["dark", null]);
  assert.equal(dark.seems_for, "light");
  // Soft edges keep their colour (resvg's pixels are premultiplied; they're put back): a half-clear white is white.
  const soft = await readLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ffffff" fill-opacity="0.5"/></svg>'));
  const mid = pixel(soft.png, Math.floor(soft.width / 2), Math.floor(soft.height / 2));
  assert.deepEqual([mid.rgb, Math.abs(mid.a - 128) <= 1], ["#ffffff", true]);
  assert.equal(soft.seems_for, "dark");
  const jpeg = await readLogo(BACKED_JPEG);
  assert.equal(jpeg.width, 80, "a picture is never drawn bigger than it is");
  assert.ok(jpeg.backed && jpeg.backed.startsWith("#1"), `its own navy background: ${jpeg.backed}`);
  assert.equal(jpeg.seems_for, "dark");
});

test("on the club's colour only where it stands out there; otherwise on a dark or white tile", () => {
  const look = (ink: string, seems: "light" | "dark") => ({ ink, backed: null, seems_for: seems });
  assert.equal(logoTile("#1d4ed8", look("#ffffff", "dark"), null), null, "a light logo on a dark blue");
  assert.equal(logoTile("#f5c518", look("#ffffff", "dark"), null), "#121715", "a light logo on a light yellow: a dark tile");
  assert.equal(logoTile("#f5c518", look("#1a1a1a", "light"), null), null, "a dark logo on a light yellow");
  assert.equal(logoTile("#0b2a20", look("#1a1a1a", "light"), null), "#ffffff", "a dark logo on a dark green: a white tile");
  assert.equal(logoTile("#1d4ed8", look("#ffffff", "dark"), "light"), "#ffffff", "the owner says it's for light backgrounds");
  assert.equal(logoTile("#1d4ed8", { ink: "#fff", backed: "#102030", seems_for: "dark" }, null), "#102030", "its own background is its tile");
});

test("set in Settings: previewed with a picture, recorded, drawn into every icon and start screen, undone, taken off", async () => {
  const before = { icon: await bytes(await get("/manifest/icon-192.png")), manifest: (await (await get("/manifest/member.webmanifest")).json() as any).icons[0].src as string };
  assert.equal((await (await get("/club")).json() as any).logo, null);
  const svgMark = await get("/manifest/mark.svg");
  assert.equal(svgMark.headers.get("content-type"), "image/svg+xml");

  // The preview: the summary says where it sits and the picture is a PNG drawn on the server, never stored.
  const planned = await app.request("/actions/club.set_logo/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ logo: b64(LIGHT) }) });
  assert.equal(planned.status, 401, "only a signed-in owner or manager");
  const { plan, apply } = await import("@kumi/core");
  const p = await plan(db, "club.set_logo", { logo: b64(LIGHT) }, owner);
  assert.match(p.plan.summary.en, /dark tile/);
  assert.match(p.plan.image!, /^data:image\/png;base64,/);
  const shown = Buffer.from(p.plan.image!.split(",")[1]!, "base64");
  assert.equal(pixel(shown, 2, 2).rgb, "#f5c518", "the picture shows it on the club's colour");
  const stored = await db.selectFrom("action_run").select(["plan", "input"]).where("id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal((stored.plan as any).image, undefined, "the picture isn't kept with the run");
  await apply(db, p.runId, owner);
  const after = await db.selectFrom("action_run").select("input").where("id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal((after.input as any).logo, undefined, "the file isn't kept in the change log once applied");

  // Every image is the logo now, under new addresses.
  const club = await (await get("/club")).json() as any;
  assert.match(club.logo, /^\/manifest\/icon-192\.png\?v=[0-9a-f]{12}$/);
  const m = await (await get("/manifest/member.webmanifest")).json() as any;
  assert.notEqual(m.icons[0].src, before.manifest, "phones fetch the new icons");
  for (const [file, size] of [["icon-180", 180], ["icon-192", 192], ["icon-512", 512], ["icon-maskable-192", 192], ["icon-maskable-512", 512]] as const) {
    const r = await get(`/manifest/${file}.png`), png = await bytes(r);
    assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual([pixel(png, 0, 0).w, pixel(png, 0, 0).rgb], [size, "#121715"], `${file}: the whole icon is the dark tile`);
    assert.equal(pixel(png, size / 2, Math.round(size / 2 - size * (file.includes("maskable") ? 0.56 : 0.8) / 2 + 3)).rgb, "#ffffff", `${file}: the ball's edge, inside the safe zone`);
  }
  assert.notDeepEqual(await bytes(await get("/manifest/icon-192.png")), before.icon);
  const startup = await bytes(await get("/manifest/startup/1179x2556.png"));
  assert.equal(pixel(startup, 4, 4).rgb, "#f5c518", "the start screen is the club's colour");
  assert.equal(pixel(startup, 589, Math.round((852 + 59) / 2 * 3) - 192 * 3 / 2 + 6).rgb, "#121715", "with the logo on a dark tile");
  const mark = await bytes(await get("/manifest/mark.png"));
  assert.deepEqual([pixel(mark, 0, 0).w, pixel(mark, 0, 0).a], [576, 0], "the in-app mark is transparent round its tile");
  assert.equal(pixel(mark, 288, 20).rgb, "#121715");
  const redirect = await get("/manifest/mark.svg");
  assert.equal(redirect.status, 302, "no SVG is served for a logo");
  assert.match(redirect.headers.get("location")!, /^\/manifest\/mark\.png\?v=/);

  // Which background it's for, alone: a light logo said to be for light backgrounds goes on a white tile.
  await run(db, "club.set_logo", { logo_for: "light" }, owner);
  assert.equal(pixel(await bytes(await get("/manifest/icon-192.png")), 0, 0).rgb, "#ffffff");
  await assert.rejects(run(db, "club.set_logo", { logo_for: "light" }, owner), /Nothing would change/);
  await run(db, "club.set_logo", { logo: b64(LIGHT) }, owner);
  assert.equal((await db.selectFrom("club").select("logo_for").executeTakeFirstOrThrow()).logo_for, "light", "a new file keeps the choice when it doesn't say");

  // A colour it stands out on: straight on the colour, no tile.
  await run(db, "club.set_logo", { logo_for: null }, owner);
  await run(db, "club.update", { brand_colour: "#1D4ED8" }, owner);
  const blue = await bytes(await get("/manifest/startup/1179x2556.png"));
  assert.equal(pixel(blue, 589, Math.round((852 + 59) / 2 * 3) - 192 * 3 / 2 + 6).rgb, "#1d4ed8", "no tile on the blue");

  // Undo puts the last logo setting back; taking it off brings the drawn mark back.
  const off = await run(db, "club.set_logo", { logo: null }, owner);
  assert.equal((await (await get("/club")).json() as any).logo, null);
  assert.equal((await get("/manifest/mark.svg")).headers.get("content-type"), "image/svg+xml");
  assert.equal(pixel(await bytes(await get("/manifest/icon-192.png")), 0, 0).rgb, "#1d4ed8");
  await run(db, "action.undo", { run_id: off.runId }, owner);
  assert.ok((await (await get("/club")).json() as any).logo, "undo brings the logo back");
  await assert.rejects(run(db, "club.set_logo", { logo: b64("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>") }, owner), /scripts, links/);
  await run(db, "club.update", { brand_colour: "#F5C518" }, owner);
});

test("club.yaml: a logo path from the file's folder, set once, and again only when the file or its background changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logo7-setup-"));
  writeFileSync(join(dir, "mark.svg"), DARK);
  const yaml = (extra: string) => { writeFileSync(join(dir, "club.yaml"), `club:\n  name: Kestrel Padel\n  time_zone: America/Los_Angeles\n  logo: mark.svg\n${extra}owner:\n  name: Robin Hale\n  email: robin@example.test\n`); return readClubFile(join(dir, "club.yaml")); };
  let r = await setupClub(db, yaml(""), { apply: false, lang: "en" });
  assert.ok(r.steps.some((s) => s.action === "club.set_logo" && /mark\.svg/.test(s.text.en)));
  await setupClub(db, yaml(""), { apply: true, lang: "en" });
  r = await setupClub(db, yaml(""), { apply: false, lang: "en" });
  assert.ok(!r.steps.some((s) => s.action === "club.set_logo"), "the same file is the logo already");
  r = await setupClub(db, yaml("  logo_for: dark\n"), { apply: false, lang: "en" });
  assert.ok(r.steps.some((s) => s.action === "club.set_logo"));
  writeFileSync(join(dir, "club.yaml"), "club:\n  name: K\n  time_zone: America/Los_Angeles\n  logo: nowhere.svg\nowner:\n  name: R\n  email: r@example.test\n");
  assert.throws(() => readClubFile(join(dir, "club.yaml")), /no file at/);
});
