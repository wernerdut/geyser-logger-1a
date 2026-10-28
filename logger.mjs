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
import { decide, diff, checkAlerts, ALLOWED_CODES } from "./control.mjs";
import { balanceOf, dailyRate, prepaidAlerts, resolveReadings, gridAlerts } from "./prepaid.mjs";

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

async function tuyaRequest(method, p, token, query, body) {
  const keys = Object.keys(query || {}).filter((k) => query[k] !== undefined && query[k] !== null).sort();
  const url = keys.length ? `${p}?${keys.map((k) => `${k}=${query[k]}`).join("&")}` : p;
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const t = String(Date.now());
  const nonce = crypto.randomUUID();
  const sts = [method, sha256(bodyStr), "", url].join("\n");
  const headers = {
    client_id: TUYA_ID, t, nonce, sign_method: "HMAC-SHA256",
    sign: tuyaSign(TUYA_ID + (token || "") + t + nonce + sts),
    "Content-Type": "application/json",
  };
  if (token) headers.access_token = token;
  return (await fetchJson(TUYA_BASE + url, { method, headers, body: bodyStr || undefined })).json;
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

async function tuya(method, p, query, body) {
  let token = await tuyaToken();
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await tuyaRequest(method, p, token, query, body);
    if (r?.success) return r.result;
    if (Number(r?.code) === 40000309) { await sleep(3000 * (attempt + 1)); continue; } // rate limited
    if ([1010, 1011, 1012].includes(Number(r?.code))) { // token replaced by a parallel run: get a fresh one
      tuyaTokenCache = null; await sleep(2000); token = await tuyaToken(); continue;
    }
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
    load_w: num(load.totalPower), grid_w: num(grid.pac), grid_import_total_kwh: num(grid.etotalFrom),
    grid_hz: num(grid.fac), grid_status: grid.status ?? null,
    batt_soc: num(battery.soc), batt_w: num(battery.power),
  };
}

let plantIdCache = null;
async function plantId() {
  if (plantIdCache) return plantIdCache;
  const plants = await ss("api/v1/plants?page=1&limit=20&name=&status=");
  plantIdCache = plants?.infos?.[0]?.id;
  if (!plantIdCache) throw new Error("Sunsynk: no plant found");
  return plantIdCache;
}

// Daily grid import (kWh) for a month, [{date, kwh}].
async function sunsynkMonthImport(ym) {
  const id = await plantId();
  const d = await ss(`api/v1/plant/energy/${id}/month?lan=en&date=${ym}&id=${id}`);
  const s = (d?.infos ?? []).find((x) => x.label === "Purchased electricity");
  return (s?.records ?? []).map((r) => ({ date: r.time, kwh: num(r.value) }));
}

async function sunsynkDay(date) {
  const id = await plantId();
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
  if (g.status === "fulfilled") {
    try { row.control = await control(now, row); } catch (e) { row.control = { error: String(e?.message || e) }; }
  }
  // Power alerts (prepaid + grid) only when the inverter was read; null leaves open [power] issues alone.
  let power = null;
  if (s.status === "fulfilled") {
    power = [];
    if (row.grid_import_total_kwh != null) {
      try { power.push(...((await prepaid(now, row)) ?? [])); } catch (e) { row.prepaid = { error: String(e?.message || e) }; }
    }
    power.push(...gridAlerts({ row, balance: row.prepaid?.balance_kwh ?? null }));
  }
  try { await alerts(now, row, power); } catch (e) { console.error("alerts failed:", e?.message || e); }
  try { await ledgerUpdateMessage(row); } catch (e) { console.error("ledger message failed:", e?.message || e); }
  await heartbeat(row, errors);
  await appendLine(`samples/${localDate(now)}.jsonl`, JSON.stringify(row));
  console.log(
    `${row.local} tank=${row.tank_c ?? "-"} coll=${row.collector_c ?? "-"} pump=${row.pump ?? "-"} elem=${row.element ?? "-"} ` +
    `pv=${row.pv_w ?? "-"} load=${row.load_w ?? "-"} grid=${row.grid_w ?? "-"} soc=${row.batt_soc ?? "-"}` +
    (errors.length ? ` ERRORS: ${errors.join(" | ")}` : "")
  );
  if (row.control) console.log(`control: ${JSON.stringify(row.control)}`);
  if (row.prepaid) console.log(`prepaid: ${JSON.stringify(row.prepaid)}`);
  if (errors.length === 2) process.exitCode = 1;
}

// ---------- control (switch + Block1-4 only) ----------
async function loadSchedule() {
  return JSON.parse(await fs.readFile(path.join(env.SCHEDULE_DIR || ".", "schedule.json"), "utf8"));
}

async function writeProp(code, value) {
  if (!ALLOWED_CODES.has(code)) throw new Error(`refusing to write ${code}`);
  if (code === "switch" ? typeof value !== "boolean" : !(Number.isInteger(value) && value >= 30 && value <= 65)) {
    throw new Error(`refusing out-of-range ${code}=${value}`);
  }
  await tuya("POST", `/v2.0/cloud/thing/${TUYA_DEVICE}/shadow/properties/issue`, null, { properties: JSON.stringify({ [code]: value }) });
}

async function control(now, row) {
  const schedule = await loadSchedule();
  const minute = Number(localTime(now).slice(0, 2)) * 60 + Number(localTime(now).slice(3, 5));
  const current = { switchOn: row.power, blocks: row.blocks };
  const { desired, reasons } = decide({ minute, schedule, tank: row.tank_c, soc: row.batt_soc ?? null, switchOn: row.power, blocks: row.blocks });
  const writes = diff(desired, current);
  const out = { reasons, desired, writes: [] };
  if (!schedule.control_enabled || env.CONTROL_DRY_RUN === "1") {
    out.dry_run = true; out.writes = writes; return out;
  }
  for (const w of writes) {
    try { await writeProp(w.code, w.value); out.writes.push({ ...w, ok: true }); }
    catch (e) { out.writes.push({ ...w, ok: false, error: String(e?.message || e) }); }
    await sleep(2500); // the Geyserwise can drop settings sent back-to-back
  }
  if (out.writes.length) {
    try {
      const after = await readGeyser();
      out.after = { switch: after.power, blocks: after.blocks };
      out.confirmed = after.power === desired.switch && after.blocks.every((v, i) => v === desired.blocks[i]);
    } catch (e) { out.after_error = String(e?.message || e); }
  }
  return out;
}

// ---------- prepaid electricity ----------
async function prepaid(now, row) {
  const raw = JSON.parse(await fs.readFile(path.join(env.SCHEDULE_DIR || ".", "prepaid.json"), "utf8"));
  const rows = [row];
  for (const d of [localDate(now), localDate(new Date(now.getTime() - 24 * 3600 * 1000))]) {
    try {
      const txt = await fs.readFile(path.join(DATA_DIR, `samples/${d}.jsonl`), "utf8");
      for (const l of txt.split("\n")) if (l.trim()) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } }
    } catch { /* no file yet */ }
  }
  const ledger = resolveReadings(raw, rows);
  const bal = balanceOf(ledger, row.grid_import_total_kwh);
  if (!bal) return null;
  const today = localDate(now);
  const ym = today.slice(0, 7);
  let daily = await sunsynkMonthImport(ym);
  if (daily.filter((d) => d.date < today).length < 7) {
    const [y, m] = ym.split("-").map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    daily = [...(await sunsynkMonthImport(prev)), ...daily];
  }
  const rate = dailyRate(daily, today, 7);
  const local = `${today} ${localTime(now)}`;
  row.prepaid = {
    balance_kwh: bal.balance, rate_kwh_day: rate, days_left: rate ? Math.round((bal.balance / rate) * 10) / 10 : null,
    estimated: bal.estimated,
  };
  return prepaidAlerts({ local, balance: bal.balance, rate, ledger, estimated: bal.estimated });
}

// ---------- alerts: GitHub issues on this repo (GitHub emails the owner), mirrored to Tannie when configured ----------
// `power` is the list of prepaid alerts, or null when the prepaid check didn't run (then open [power] issues are left alone).
async function alerts(now, row, power) {
  const schedule = await loadSchedule();
  let recentRows = [];
  try {
    const txt = await fs.readFile(path.join(DATA_DIR, `samples/${localDate(now)}.jsonl`), "utf8");
    recentRows = txt.trim().split("\n").filter(Boolean).slice(-10).map((l) => JSON.parse(l));
  } catch { /* first row of the day */ }
  const found = [...checkAlerts({ row, recentRows, schedule }), ...(power ?? [])];
  if (found.length) row.alerts = found.map((a) => a.key);
  const token = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    if (found.length) console.log("alerts (not posted, no GitHub token):", found.map((a) => a.title).join(" | "));
    return;
  }
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const open = (await fetchJson(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers: h })).json;
  const openList = Array.isArray(open) ? open.filter((i) => !i.pull_request) : [];
  for (const a of found) {
    if (openList.some((i) => i.title === a.title)) continue; // already open: don't spam
    const r = await fetchJson(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ title: a.title, body: a.body }),
    });
    console.log(`alert ${a.key}: issue ${r.json?.number ?? r.status}`);
    const link = r.json?.html_url ? `\n\n${r.json.html_url}` : "";
    await notifyTannie(`*${a.title.replace(/^\[[^\]]+\]\s*/, "")}*\n\n${a.body}${link}`);
  }
  // Close [power] issues whose condition has cleared (a token was recorded, or the month rolled over).
  if (power) {
    const live = new Set(found.map((a) => a.title));
    for (const i of openList.filter((i) => i.title.startsWith("[power]") && !live.has(i.title))) {
      await fetchJson(`https://api.github.com/repos/${repo}/issues/${i.number}/comments`, {
        method: "POST", headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ body: `Cleared at ${row.local}: ${JSON.stringify(row.prepaid)}` }),
      });
      await fetchJson(`https://api.github.com/repos/${repo}/issues/${i.number}`, {
        method: "PATCH", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ state: "closed" }),
      });
      console.log(`closed cleared alert #${i.number}`);
      if (i.title === "[power] Grid down at 1A Welgemeend") {
        const mins = Math.round((Date.parse(row.ts) - Date.parse(i.created_at)) / 60000);
        await notifyTannie(`*Grid back at 1A Welgemeend* (${row.local.slice(11, 16)}, down ~${mins} min or less). Battery ${row.batt_soc ?? "?"}%.`);
      }
    }
  }
}

// After Tannie commits a token or reading ("ledger: ..." commit), tell Werner the new balance.
async function ledgerUpdateMessage(row) {
  const msg = env.HEAD_COMMIT_MESSAGE || "";
  if (env.GITHUB_EVENT_NAME !== "push" || !msg.startsWith("ledger:") || !row.prepaid || row.prepaid.error) return;
  const p = row.prepaid;
  await notifyTannie(`*Ledger updated* (${msg.split("\n")[0].slice(7).trim()})\n\nMeter now ~${Math.round(p.balance_kwh)} kWh` +
    (p.days_left != null ? `, about ${p.days_left} days at ~${Math.round(p.rate_kwh_day)} kWh/day.` : "."));
}

// Tannie watches for these; two hours of silence means the logger (and every alert) has stopped.
async function heartbeat(row, errors) {
  const url = (env.TANNIE_NOTIFY_URL || "").trim().replace(/\/notify$/, "/heartbeat"), tok = (env.TANNIE_NOTIFY_TOKEN || "").trim();
  if (!url || !tok || url === (env.TANNIE_NOTIFY_URL || "").trim()) return;
  try {
    const r = await fetchJson(url, {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "geyser-logger-1a", local: row.local, errors: errors.length }),
    });
    console.log(`heartbeat: ${r.status}`);
  } catch (e) { console.error("heartbeat failed:", e?.message || e); }
}

// Optional WhatsApp via Tannie. No-op until TANNIE_NOTIFY_URL and TANNIE_NOTIFY_TOKEN secrets exist.
async function notifyTannie(text) {
  const url = (env.TANNIE_NOTIFY_URL || "").trim(), tok = (env.TANNIE_NOTIFY_TOKEN || "").trim();
  if (!url || !tok) return;
  try {
    const r = await fetchJson(url, {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, source: "geyser-logger-1a" }),
    });
    console.log(`tannie notify: ${r.status}`);
  } catch (e) { console.error("tannie notify failed:", e?.message || e); }
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
