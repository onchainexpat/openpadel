import { test } from "node:test";
import assert from "node:assert/strict";
import { qrMatrix, qrSvg } from "../src/qr.ts";

// Reference symbols from an independent encoder (the Python qrcode package, byte mode, level M, the mask
// fixed): versions 1, 8 and 10, so finder, timing, alignment and version patterns, and blocks of two sizes,
// are all checked. Each row is the modules as bits, in hex.
const REFERENCE = [
  { mask: 0, text: "kumi",
    rows: ["fe3bf8", "829a08", "ba62e8", "ba0ae8", "bafae8", "823208", "feabf8", "002000", "aa0890", "617508", "d27778", "613d88", "1e7700", "00e238", "fe68f8", "824210", "ba8a98", "ba5570", "baf768", "823dd0", "fef738"] },
  { mask: 6, text: "otpauth://totp/Kestrel%20Padel%3Adana%40kestrel.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kestrel%20Padel&algorithm=SHA1&digits=6&period=30",
    rows: ["fe95e22be8bf8", "82f0a894aba08", "bab45505ddae8", "ba624abbdd2e8", "baf317ef9c2e8", "82018e2d16208", "feaaaaaaaabf8", "002b023c11800", "9f835bff1f4b8", "b8829efef7f10", "06a4c89fe5178", "4ca21302ba3f8", "93de498aeffe8", "39e1deb6936d0", "f734a35c509d8", "8c562ae375f70", "ab0042a1fffe0", "0d7792cf68bf0", "4b00aa99599f8", "b5093d7e5ba48", "3f1784ee3d410", "58fc5bfb6efa8", "1ff02fe0b8fc8", "4894023de58f8", "ca8c96acbead8", "48d9ce3ecb890", "3fa13fea5ffc8", "25da1382633f8", "ea3a8965fb608", "89269acefc530", "abc6b239dfa28", "8d99435d488d8", "4776da0e79858", "8984f9a36eba0", "db5308e1f7748", "54fda0c7af168", "66420dec89648", "15f069da528b8", "470868950be18", "71494e9a379e8", "e3c587e5afff0", "00a71632e48b0", "fe9e8abb98a98", "82acfa34348d8", "badaf7ee3afa8", "ba914c0eeb758", "ba714df7ac7d0", "8268e3c299b78", "fe87ea5ca93c8"] },
  { mask: 3, text: "otpauth://totp/Long%20Club%20Name%20Padel%20Pickleball%3Asomeone.long%40example-club.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Long%20Club%20Name%20Padel%20Pickleball&algorithm=SHA1&digits=6&period=30",
    rows: ["fe9401d708733f8", "82f3389ed02d208", "ba50f453c81b2e8", "bafce8131d412e8", "ba203a3eda8d2e8", "821f3b231ad2208", "feaaaaaaaaaabf8", "00baec225c46000", "b765aafe37a4258", "7c8831de1d25cf8", "968d1666e022448", "ec7f7944386bb58", "fb829ae57c60000", "6ca7e8f907dc3c0", "2f4856d50d60f00", "5da9db1b85d0da8", "3a2863c1e63df68", "6059614c355f158", "1f9075896e22770", "115c81f027cf188", "4a0d7b9c36e2ba8", "81eff0d69478c50", "82b158f3506b838", "bd7438c6ec4cc50", "daa24b271a52648", "2d02b2600b0c650", "3fc9c67e1bc4f80", "a8cbed63542a8e8", "1aedc7abe75ea90", "f891972324d78c8", "efa5eebe3233fe0", "5d009e27d8a6198", "2a07701075d2160", "58625296d479c70", "cbdee770e71bff0", "05ca3e3bec77ed0", "cfa6d6391a34480", "64fd06109a80040", "32764e195b3c0a0", "bd8e9abc555b278", "ee8aab29932fee0", "1479a15978c6dc0", "eb0660e64396430", "1d2d27765bf0088", "1eedf6e975c0270", "79674fa0cd38828", "a776b6d9ebb2648", "f9104a0aca8fed8", "03e3a83e1a54f80", "00f748220f9c8c0", "fe9d096b46b8af0", "82b5f8a241aa8e0", "ba1d54ffa339fb0", "bafbf015b1db830", "baeb6f06a0bfc60", "8242f93552ae708", "febdfd1335e76e0"] },
];
const hexRows = (m: boolean[][]) => m.map((r) => { const bits = r.map((d) => (d ? "1" : "0")).join("").padEnd(Math.ceil(r.length / 4) * 4, "0"); return bits.match(/.{4}/g)!.map((b) => parseInt(b, 2).toString(16)).join(""); });

test("QR codes match an independent encoder, module for module", () => {
  for (const c of REFERENCE) assert.deepEqual(hexRows(qrMatrix(c.text, c.mask)), c.rows, `${c.text.slice(0, 24)} mask ${c.mask}`);
});

test("the mask chosen is one of the eight, and the picture has a quiet zone", () => {
  const text = REFERENCE[1]!.text, auto = JSON.stringify(qrMatrix(text));
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].some((m) => JSON.stringify(qrMatrix(text, m)) === auto));
  assert.match(qrSvg("kumi"), /^<svg [^>]*viewBox="0 0 29 29"/);   // 21 modules and 4 either side
  assert.throws(() => qrMatrix("x".repeat(300)), /too long/);
});
