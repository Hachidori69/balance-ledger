// Builds data/register.json: every Balance artwork with its balance, history and ink.
// Run with Node 20+:  node scripts/snapshot.mjs
// Optional: set RPC_URL to your own Ethereum node (Alchemy, Infura, etc.) for speed.
// Set FULL=1 to force a full rebuild instead of an incremental update.
//
// Reads are bundled through Multicall3 (~250 reads per request). After the first full
// build, each run only re-reads wallets that had BALANCE transfers since the last run.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const TOKEN = "0x3620540c994433d7b4a628c46d2ed5f92572ea07";
const ART = "0x3f2ba6c00c386986686a429c52099aacd51b7e38";
const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const OUT = "data/register.json";
const FULL_EVERY_MS = 6 * 60 * 60 * 1000; // full rebuild at least every 6 hours
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
const SEL = { balanceOf: "70a08231", historyOf: "0bb4b6aa", inkOf: "e7296cc1", totalSupply: "18160ddd", page: "b7134dfa", aggregate3: "82ad56cb" };

/* ---------- RPC ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpcIdx = 0, reqId = 1;
async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < RPCS.length * 3; attempt++) {
    const url = RPCS[(rpcIdx + attempt) % RPCS.length];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: reqId++, method, params })
      }).finally(() => clearTimeout(timer));
      if (!r.ok) throw new Error(url + " HTTP " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(url + " " + (j.error.message || "error"));
      rpcIdx = (rpcIdx + attempt) % RPCS.length;
      return j.result;
    } catch (e) { last = e; await sleep(400 * (1 + Math.floor(attempt / RPCS.length))); }
  }
  throw last;
}
const ethCall = (to, data) => rpc("eth_call", [{ to, data: "0x" + data }, "latest"]);
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------- ABI ---------- */
const pad = (h) => h.padStart(64, "0");
const encAddr = (a) => pad(a.toLowerCase().replace(/^0x/, ""));
const encUint = (n) => pad(BigInt(n).toString(16));
const word = (hex, i) => BigInt("0x" + (hex.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"));
const wordAddr = (hex, i) => "0x" + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);

// aggregate3((address target, bool allowFailure, bytes callData)[]) -> (bool success, bytes returnData)[]
function encAggregate3(calls) {
  const tuples = calls.map((c) => {
    const len = c.data.length / 2;
    return encAddr(c.target) + encUint(1) + encUint(96) + encUint(len) + c.data.padEnd(Math.ceil(c.data.length / 64) * 64, "0");
  });
  const offs = []; let cur = calls.length * 32;
  for (const t of tuples) { offs.push(encUint(cur)); cur += t.length / 2; }
  return SEL.aggregate3 + encUint(32) + encUint(calls.length) + offs.join("") + tuples.join("");
}
function decAggregate3(hex) {
  const h = hex.slice(2);
  const W = (b) => BigInt("0x" + h.slice(b * 2, b * 2 + 64));
  const arr = Number(W(0)), n = Number(W(arr)), base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + Number(W(base + i * 32));
    const ok = W(t) !== 0n;
    const d = t + Number(W(t + 32));
    const len = Number(W(d));
    out.push(ok ? "0x" + h.slice((d + 32) * 2, (d + 32 + len) * 2) : null);
  }
  return out;
}
async function multicall(calls, size = 250, concurrency = 3) {
  const chunks = [];
  for (let i = 0; i < calls.length; i += size) chunks.push(calls.slice(i, i + size));
  const parts = await pool(chunks, concurrency, async (chunk) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return decAggregate3(await ethCall(MULTICALL, encAggregate3(chunk))); }
      catch (e) { if (attempt === 2) throw e; await sleep(800); }
    }
  });
  return parts.flat();
}

/* ---------- Row format ----------
   [addr, id, balance, peak, transfersIn, transfersOut, returnsFromZero, timesEmptied,
    statementsConverted, firstReceipt, inkC, inkM, inkY, inkK, contract, label]
   balance and peak are in tokens (4 decimals); ink is parts per 10,000. */
const tokens = (wei) => Number(wei / 10n ** 14n) / 1e4;
function inkParts(ink) {
  const sum = ink.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return [0, 0, 0, 0];
  return ink.map((v) => Number((v * 10000n) / sum));
}
function makeRow(addr, id, bal, histHex, inkHex, prev) {
  const h = histHex ? Array.from({ length: 10 }, (_, j) => word(histHex, j)) : null;
  const ink = inkHex ? [0, 1, 2, 3].map((j) => word(inkHex, j)) : null;
  const label = KNOWN[addr] || "";
  // history: firstReceipt, received, sent, transfersIn, transfersOut, contributed, statements, peak, emptied, returnsFromZero
  return [
    addr, id, tokens(bal),
    h ? tokens(h[7]) : prev ? prev[3] : 0,
    h ? Number(h[3]) : prev ? prev[4] : 0,
    h ? Number(h[4]) : prev ? prev[5] : 0,
    h ? Number(h[9]) : prev ? prev[6] : 0,
    h ? Number(h[8]) : prev ? prev[7] : 0,
    h ? Number(h[6]) : prev ? prev[8] : 0,
    h ? Number(h[0]) : prev ? prev[9] : 0,
    ...(ink ? inkParts(ink) : prev ? prev.slice(10, 14) : [0, 0, 0, 0]),
    (prev && prev[14]) || (label && label !== "Visualize Value") ? 1 : 0,
    label
  ];
}

/* ---------- Steps ---------- */
async function readWallets(fromIndex, total) {
  const calls = [];
  for (let s = fromIndex; s < total; s += 64) calls.push({ target: ART, data: SEL.page + encUint(s) + encUint(64) });
  const res = await multicall(calls, 20, 3);
  const list = [];
  res.forEach((hex, k) => {
    if (!hex) throw new Error("Missing wallet page at " + (fromIndex + k * 64));
    const o1 = Number(word(hex, 0)) / 32, o2 = Number(word(hex, 1)) / 32, n = Number(word(hex, o1));
    for (let i = 0; i < n; i++) list.push({ addr: wordAddr(hex, o1 + 1 + i).toLowerCase(), id: fromIndex + k * 64 + i + 1, bal: word(hex, o2 + 1 + i) });
  });
  return list;
}
async function readDetails(addrs) {
  const calls = [];
  for (const a of addrs) {
    calls.push({ target: TOKEN, data: SEL.balanceOf + encAddr(a) });
    calls.push({ target: TOKEN, data: SEL.historyOf + encAddr(a) });
    calls.push({ target: TOKEN, data: SEL.inkOf + encAddr(a) });
  }
  const res = await multicall(calls, 240, 3);
  const out = new Map();
  addrs.forEach((a, i) => out.set(a, { bal: res[i * 3] ? word(res[i * 3], 0) : null, hist: res[i * 3 + 1], ink: res[i * 3 + 2] }));
  return out;
}
async function flagContracts(rows, minBalance) {
  const cand = rows.filter((r) => !r[14] && r[2] >= minBalance).slice(0, 150);
  const codes = await pool(cand, 4, async (r) => { try { return await rpc("eth_getCode", [r[0], "latest"]); } catch (e) { return null; } });
  cand.forEach((r, i) => { if (codes[i] && codes[i] !== "0x") r[14] = 1; });
}
async function touchedSince(fromBlock, toBlock) {
  const set = new Set();
  const STEP = 2000;
  for (let b = fromBlock; b <= toBlock; b += STEP) {
    const end = Math.min(toBlock, b + STEP - 1);
    const logs = await rpc("eth_getLogs", [{ address: TOKEN, topics: [TRANSFER_TOPIC], fromBlock: "0x" + b.toString(16), toBlock: "0x" + end.toString(16) }]);
    for (const l of logs) {
      for (const t of [l.topics[1], l.topics[2]]) {
        if (!t) continue;
        const a = "0x" + t.slice(26).toLowerCase();
        if (a !== "0x0000000000000000000000000000000000000000") set.add(a);
      }
    }
  }
  return set;
}

async function fullBuild(block) {
  const total = Number(word(await ethCall(ART, SEL.totalSupply), 0));
  console.log("Full build. Artworks:", total);
  const list = await readWallets(0, total);
  console.log("Wallets read:", list.length);
  const details = await readDetails(list.map((r) => r.addr));
  let missing = 0;
  const rows = list.map((r) => {
    const d = details.get(r.addr);
    if (!d.hist || !d.ink) missing++;
    return makeRow(r.addr, r.id, d.bal ?? r.bal, d.hist, d.ink, null);
  });
  if (missing > rows.length * 0.01) throw new Error(missing + " wallets missing details; not writing a partial snapshot");
  await flagContracts([...rows].sort((a, b) => b[2] - a[2]), 1000);
  return { t: Date.now(), full: Date.now(), block, rows };
}

async function incremental(prev, block) {
  const total = Number(word(await ethCall(ART, SEL.totalSupply), 0));
  const rows = prev.rows;
  const index = new Map(rows.map((r, i) => [r[0], i]));
  const known = rows.length;
  const added = known < total ? await readWallets(known, total) : [];
  const touched = await touchedSince(prev.block + 1, block);
  for (const r of added) touched.add(r.addr);
  console.log(`Incremental: blocks ${prev.block + 1}-${block}, ${added.length} new artworks, ${touched.size} wallets to refresh`);

  const addrs = [...touched].filter((a) => index.has(a) || added.some((r) => r.addr === a));
  const details = await readDetails(addrs);
  const ids = new Map(added.map((r) => [r.addr, r.id]));
  for (const a of addrs) {
    const d = details.get(a);
    const i = index.get(a);
    const prevRow = i !== undefined ? rows[i] : null;
    const row = makeRow(a, prevRow ? prevRow[1] : ids.get(a), d.bal ?? 0n, d.hist, d.ink, prevRow);
    if (i !== undefined) rows[i] = row; else { index.set(a, rows.length); rows.push(row); }
  }
  rows.sort((a, b) => a[1] - b[1]);
  await flagContracts(addrs.map((a) => rows.find((r) => r[0] === a)).filter(Boolean), 1000);
  return { t: Date.now(), full: prev.full, block, rows };
}

async function main() {
  const t0 = Date.now();
  const block = Number(await rpc("eth_blockNumber", []));
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch (e) { /* first run */ }

  const canIncrement = !process.env.FULL && prev && prev.block && prev.full && Array.isArray(prev.rows) &&
    prev.rows.length && prev.rows[0].length === 16 && Date.now() - prev.full < FULL_EVERY_MS && block - prev.block < 20000;
  const snap = canIncrement ? await incremental(prev, block) : await fullBuild(block);

  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(snap));
  console.log(`Wrote ${snap.rows.length} rows at block ${block} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
