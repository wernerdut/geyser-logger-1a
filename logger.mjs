// 1A Welgemeend geyser + solar logger (read-only). Runs in GitHub Actions.
//
//   node logger.mjs snapshot   -> appends one reading to samples/YYYY-MM-DD.jsonl
//   node logger.mjs archive    -> saves yesterday's full-resolution history to archive/YYYY-MM-DD.json
//
// It never changes anything on the geyser or the inverter.
// Credentials come from environment variables (GitHub repository secrets).

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const env = process.env;
const TZ = "Africa/Johannesburg";
const TIMEOUT_MS = 20000;
const DATA_DIR = env.DATA_DIR || ".";

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const localDate = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const localTime = (d) => d.toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false });
const localStamp = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: TZ });

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, json: { raw: text.slice(0, 200) } }; }
  } finally { clearTimeout(t); }
}

async function appendLine(rel, line) {
  const p = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, line + "\n");
}
async function writeJson(rel, obj) {
  const p = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj) + "\n");
}

// ---------- Tuya Cloud ----------
const TUYA_REGIONS = {
  eu: "https://openapi.tuyaeu.com", us: "https://openapi.tuyaus.com",
  cn: "https://openapi.tuyacn.com", in: "https://openapi.tuyain.com",
};
const TUYA_BASE = (env.TUYA_BASE_URL || TUYA_REGIONS[(env.TUYA_REGION || "eu").toLowerCase()] || TUYA_REGIONS.eu).replace(/\/+$/, "");
const TUYA_ID = (env.TUYA_ACCESS_ID || "").trim();
const TUYA_SECRET = (env.TUYA_ACCESS_SECRET || "").trim();
const TUYA_DEVICE = (env.TUYA_DEVICE_ID || "").trim();

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const tuyaSign = (s) => crypto.createHmac("sha256", TUYA_SECRET).update(s, "utf8").digest("hex").toUpperCase();

async function tuyaRequest(method, p, token, query) {
  const keys = Object.keys(query || {}).filter((k) => query[k] !== undefined && query[k] !== null).sort();
  const url = keys.length ? `${p}?${keys.map((k) => `${k}=${query[k]}`).join("&")}` : p;
  const t = String(Date.now());
  const nonce = crypto.randomUUID();
  const sts = [method, sha256(""), "", url].join("\n");
  const headers = {
    client_id: TUYA_ID, t, nonce, sign_method: "HMAC-SHA256",
    sign: tuyaSign(TUYA_ID + (token || "") + t + nonce + sts),
  };
  if (token) headers.access_token = token;
  return (await fetchJson(TUYA_BASE + url, { method, headers })).json;
}

let tuyaTokenCache = null;
async function tuyaToken() {
  if (tuyaTokenCache) return tuyaTokenCache;
  if (!TUYA_ID || !TUYA_SECRET || !TUYA_DEVICE) throw new Error("Tuya secrets or device id not set");
  const r = await tuyaRequest("GET", "/v1.0/token", null, { grant_type: 1 });
  if (!r?.success || !r?.result?.access_token) throw new Error(`Tuya login: ${r?.msg || "failed"} (code ${r?.code ?? "?"})`);
  tuyaTokenCache = r.result.access_token;
  return tuyaTokenCache;
}

async function tuya(method, p, query) {
  const token = await tuyaToken();
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await tuyaRequest(method, p, token, query);
    if (r?.success) return r.result;
    if (Number(r?.code) === 40000309) { await sleep(3000 * (attempt + 1)); continue; } // rate limited
    throw new Error(`Tuya ${p}: ${r?.msg || "failed"} (code ${r?.code ?? "?"})`);
  }
  throw new Error(`Tuya ${p}: still rate limited after retries`);
}

async function readGeyser() {
  const res = await tuya("GET", `/v2.0/cloud/thing/${TUYA_DEVICE}/shadow/properties`);
  const p = {};
  for (const x of res?.properties ?? []) p[x.code] = x.value;
  return {
    tank_c: num(p.temp_current),
    collector_c: num(p.Collector_Temp),
    pump: p.Pump ?? null,
    element: p.work_state ?? null,
    power: p.switch ?? null,
    mode: p.mode ?? null,
    fault: num(p.fault),
    blocks: [p.Block1, p.Block2, p.Block3, p.Block4].map(num),
    solar_diff_c: num(p.Solar_Differential),
  };
}

async function tuyaTempLog(startMs, endMs) {
  const out = [];
  let lastRowKey;
  for (let page = 0; page < 60; page++) {
    const res = await tuya("GET", `/v2.0/cloud/thing/${TUYA_DEVICE}/report-logs`, {
      codes: "temp_current", start_time: startMs, end_time: endMs, size: 100, last_row_key: lastRowKey,
    });
    for (const l of res?.logs ?? []) out.push([localStamp(Number(l.event_time)), num(l.value)]);
    if (!res?.has_more || !res?.last_row_key) break;
    lastRowKey = res.last_row_key;
    await sleep(1500);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

// ---------- Sunsynk Connect ----------
const SS_BASE = (env.SUNSYNK_BASE_URL || "https://api.sunsynk.net").replace(/\/+$/, "");
const SS_USER = (env.SUNSYNK_USERNAME || "").trim();
const SS_PASS = env.SUNSYNK_PASSWORD || "";
const SS_SN = (env.SUNSYNK_INVERTER_SN || "").trim();
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

let ssTokenCache = null;
async function ssToken() {
  if (ssTokenCache) return ssTokenCache;
  if (!SS_USER || !SS_PASS) throw new Error("Sunsynk secrets not set");
  const n1 = Date.now();
  const pk = (await fetchJson(`${SS_BASE}/anonymous/publicKey?nonce=${n1}&source=sunsynk&sign=${md5(`nonce=${n1}&source=sunsynkPOWER_VIEW`)}`)).json;
  if (!pk?.success || !pk?.data) throw new Error(`Sunsynk key: ${pk?.msg || "failed"}`);
  const pem = `-----BEGIN PUBLIC KEY-----\n${pk.data}\n-----END PUBLIC KEY-----`;
  const enc = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(SS_PASS, "utf8")).toString("base64");
  const n2 = Date.now();
  const body = {
    username: SS_USER, password: enc, grant_type: "password", client_id: "csp-web", source: "sunsynk",
    nonce: n2, sign: md5(`nonce=${n2}&source=sunsynk${String(pk.data).slice(0, 10)}`),
  };
  const r = (await fetchJson(`${SS_BASE}/oauth/token/new`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
  })).json;
  if (!r?.success || !r?.data?.access_token) throw new Error(`Sunsynk login: ${r?.msg || "failed"}`);
  ssTokenCache = r.data.access_token;
  return ssTokenCache;
}

async function ss(p) {
  const token = await ssToken();
  const r = await fetchJson(`${SS_BASE}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status !== 200 || r.json?.success === false) throw new Error(`Sunsynk ${p.split("?")[0]}: ${r.json?.msg || r.status}`);
  return r.json?.data ?? {};
}

async function readSunsynk() {
  if (!SS_SN) throw new Error("Sunsynk inverter serial not set");
  const [input, battery, grid, load] = await Promise.all([
    ss(`api/v1/inverter/${SS_SN}/realtime/input`),
    ss(`api/v1/inverter/battery/${SS_SN}/realtime?sn=${SS_SN}&lan=en`),
    ss(`api/v1/inverter/grid/${SS_SN}/realtime?sn=${SS_SN}`),
    ss(`api/v1/inverter/load/${SS_SN}/realtime?sn=${SS_SN}`),
  ]);
  return {
    pv_w: num(input.pac), pv_today_kwh: num(input.etoday),
    load_w: num(load.totalPower), grid_w: num(grid.pac),
    batt_soc: num(battery.soc), batt_w: num(battery.power),
  };
}

async function sunsynkDay(date) {
  const plants = await ss("api/v1/plants?page=1&limit=20&name=&status=");
  const id = plants?.infos?.[0]?.id;
  if (!id) throw new Error("Sunsynk: no plant found");
  const d = await ss(`api/v1/plant/energy/${id}/day?lan=en&date=${date}&id=${id}`);
  const series = {};
  for (const s of d?.infos ?? []) {
    series[s.label] = Object.fromEntries((s.records ?? []).map((r) => [r.time, num(r.value)]));
  }
  return series;
}

// ---------- modes ----------
async function snapshot() {
  const now = new Date();
  const row = { ts: now.toISOString(), local: `${localDate(now)} ${localTime(now)}`, src: env.GITHUB_EVENT_NAME || "local" };
  const errors = [];
  const [g, s] = await Promise.allSettled([readGeyser(), readSunsynk()]);
  if (g.status === "fulfilled") Object.assign(row, g.value); else errors.push(`geyser: ${g.reason?.message || g.reason}`);
  if (s.status === "fulfilled") Object.assign(row, s.value); else errors.push(`sunsynk: ${s.reason?.message || s.reason}`);
  if (errors.length) row.errors = errors;
  await appendLine(`samples/${localDate(now)}.jsonl`, JSON.stringify(row));
  console.log(
    `${row.local} tank=${row.tank_c ?? "-"} coll=${row.collector_c ?? "-"} pump=${row.pump ?? "-"} elem=${row.element ?? "-"} ` +
    `pv=${row.pv_w ?? "-"} load=${row.load_w ?? "-"} grid=${row.grid_w ?? "-"} soc=${row.batt_soc ?? "-"}` +
    (errors.length ? ` ERRORS: ${errors.join(" | ")}` : "")
  );
  if (errors.length === 2) process.exitCode = 1;
}

async function archive() {
  // Yesterday in Cape Town time, so a delayed run still archives a complete day.
  const target = env.ARCHIVE_DATE || localDate(new Date(Date.now() - 24 * 3600 * 1000));
  const start = Date.parse(`${target}T00:00:00+02:00`);
  const end = start + 24 * 3600 * 1000;
  const out = { date: target, created: new Date().toISOString() };
  const errors = [];
  const [t, s] = await Promise.allSettled([tuyaTempLog(start, end), sunsynkDay(target)]);
  if (t.status === "fulfilled") out.tank_temp_log = t.value; else errors.push(`tuya: ${t.reason?.message || t.reason}`);
  if (s.status === "fulfilled") out.sunsynk_5min = s.value; else errors.push(`sunsynk: ${s.reason?.message || s.reason}`);
  if (errors.length) out.errors = errors;
  await writeJson(`archive/${target}.json`, out);
  console.log(`archive ${target}: tank readings=${out.tank_temp_log?.length ?? 0}, sunsynk series=${Object.keys(out.sunsynk_5min ?? {}).length}` +
    (errors.length ? ` ERRORS: ${errors.join(" | ")}` : ""));
  if (errors.length === 2) process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === "snapshot") await snapshot();
else if (mode === "archive") await archive();
else { console.error("usage: node logger.mjs snapshot|archive"); process.exitCode = 2; }
