// Builds data/register.json: every Balance artwork with its balance, history and ink.
// Run with Node 20+:  node scripts/snapshot.mjs
// Optional: set RPC_URL to your own Ethereum node (Alchemy, Infura, etc.) for speed.

import { mkdir, writeFile } from "node:fs/promises";

const TOKEN = "0x3620540c994433d7b4a628c46d2ed5f92572ea07";
const ART = "0x3f2ba6c00c386986686a429c52099aacd51b7e38";
const KNOWN = {
  "0x000000000004444c5dc75cb358380d2e3de08a90": "Uniswap v4 pools",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x3620540c994433d7b4a628c46d2ed5f92572ea07": "Token contract",
  "0xc8f8e2f59dd95ff67c3d39109eca2e2a017d4c8a": "Visualize Value"
};
const RPCS = [
  process.env.RPC_URL,
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth"
].filter(Boolean);
const SEL = { historyOf: "0bb4b6aa", inkOf: "e7296cc1", totalSupply: "18160ddd", page: "b7134dfa" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpcIdx = 0;
async function rpcSend(body) {
  let last;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[(rpcIdx + attempt) % RPCS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (Array.isArray(body) && !Array.isArray(j)) throw new Error("batch rejected");
      rpcIdx = (rpcIdx + attempt) % RPCS.length;
      return j;
    } catch (e) { last = e; await sleep(300); }
  }
  throw last;
}
const callReq = (to, data) => ({ method: "eth_call", params: [{ to, data: "0x" + data }, "latest"] });

async function batch(reqs, size = 25) {
  const out = new Array(reqs.length).fill(null);
  for (let pass = 0; pass < 4; pass++) {
    const todo = out.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
    if (!todo.length) break;
    const sz = pass === 0 ? size : Math.max(5, Math.floor(size / (pass * 2)));
    for (let i = 0; i < todo.length; i += sz) {
      const ids = todo.slice(i, i + sz);
      try {
        const res = await rpcSend(ids.map((id) => ({ jsonrpc: "2.0", id, ...reqs[id] })));
        for (const x of res) if (x && !x.error && typeof x.id === "number") out[x.id] = x.result;
      } catch (e) { /* retried next pass */ }
      await sleep(60);
    }
  }
  return out;
}

const pad = (h) => h.padStart(64, "0");
const encAddr = (a) => pad(a.toLowerCase().replace(/^0x/, ""));
const encUint = (n) => pad(BigInt(n).toString(16));
const word = (hex, i) => BigInt("0x" + (hex.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"));
const wordAddr = (hex, i) => "0x" + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);

async function main() {
  const t0 = Date.now();
  const [tsHex] = await batch([callReq(ART, SEL.totalSupply)]);
  if (!tsHex) throw new Error("Could not read artwork total supply");
  const total = Number(word(tsHex, 0));
  console.log("Artworks:", total);

  const pageReqs = [];
  for (let s = 0; s < total; s += 64) pageReqs.push(callReq(ART, SEL.page + encUint(s) + encUint(64)));
  const pages = await batch(pageReqs, 10);
  const list = [];
  pages.forEach((hex, pi) => {
    if (!hex) throw new Error("Missing wallet page " + pi);
    const o1 = Number(word(hex, 0)) / 32, o2 = Number(word(hex, 1)) / 32, n = Number(word(hex, o1));
    for (let i = 0; i < n; i++) list.push({ addr: wordAddr(hex, o1 + 1 + i).toLowerCase(), id: pi * 64 + i + 1, bal: word(hex, o2 + 1 + i) });
  });

  const reqs = [];
  for (const r of list) { reqs.push(callReq(TOKEN, SEL.historyOf + encAddr(r.addr))); reqs.push(callReq(TOKEN, SEL.inkOf + encAddr(r.addr))); }
  const res = await batch(reqs, 25);
  let missing = 0;
  list.forEach((r, i) => {
    const h = res[i * 2], k = res[i * 2 + 1];
    if (!h || !k) missing++;
    r.h = h ? Array.from({ length: 10 }, (_, j) => word(h, j)) : Array(10).fill(0n);
    r.ink = k ? [0, 1, 2, 3].map((j) => word(k, j)) : [0n, 0n, 0n, 0n];
  });
  if (missing > list.length * 0.02) throw new Error(missing + " wallets missing details; not writing a partial snapshot");

  const top = [...list].sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0)).slice(0, 100);
  const codes = await batch(top.map((r) => ({ method: "eth_getCode", params: [r.addr, "latest"] })), 25);
  top.forEach((r, i) => { if (codes[i] && codes[i] !== "0x") r.contract = 1; });

  // history fields: firstReceipt, received, sent, transfersIn, transfersOut, contributed, statements, peak, emptied, returnsFromZero
  const rows = list.map((r) => {
    const label = KNOWN[r.addr] || "";
    const contract = r.contract || (label && label !== "Visualize Value") ? 1 : 0;
    return [r.addr, r.id, r.bal.toString(), r.h[7].toString(), Number(r.h[3]), Number(r.h[4]), Number(r.h[9]), Number(r.h[8]),
      Number(r.h[6]), Number(r.h[0]), r.h[1].toString(), r.h[2].toString(), ...r.ink.map(String), contract, label];
  });

  await mkdir("data", { recursive: true });
  await writeFile("data/register.json", JSON.stringify({ t: Date.now(), rows }));
  console.log(`Wrote ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s (${missing} missing)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
