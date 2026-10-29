// daily.jsonl: one summary line per Cape Town day, built only from what the logger already stores
// (samples/, archive/ and the inverter's lifetime grid-import counter in the samples). Pure logic only.

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const min = (xs) => (xs.length ? Math.min(...xs) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const finite = (xs) => xs.filter((x) => Number.isFinite(x));

/** kWh from a Sunsynk 5-minute power series {"HH:MM": W}; positive part only. */
export function integrateKwh(series) {
  if (!series) return null;
  const pts = Object.entries(series).map(([t, w]) => [Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)), Number(w)])
    .filter(([m, w]) => Number.isFinite(m) && Number.isFinite(w)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  let wh = 0;
  for (let i = 0; i < pts.length; i++) {
    const dt = Math.min(15, (pts[i + 1]?.[0] ?? pts[i][0] + 5) - pts[i][0]); // gaps over 15 min are not filled
    wh += Math.max(0, pts[i][1]) * dt / 60;
  }
  return wh / 1000;
}

/** Minutes a sample flag was on: each sample stands for the time to the next one (capped at 35 min, 30 for the last). */
export function onMinutes(rows, isOn) {
  const ok = rows.filter((r) => r.ts).sort((a, b) => a.ts.localeCompare(b.ts));
  if (!ok.length) return null;
  let total = 0;
  for (let i = 0; i < ok.length; i++) {
    const next = ok[i + 1];
    const gap = next ? (Date.parse(next.ts) - Date.parse(ok[i].ts)) / 60000 : 30;
    if (isOn(ok[i])) total += Math.min(35, gap);
  }
  return Math.round(total);
}

/** The lifetime import counter at about midnight: the day's first sample, if it carries the counter and is before 01:30. */
const firstCounter = (rows) => {
  const first = [...rows].filter((r) => r.ts).sort((a, b) => a.ts.localeCompare(b.ts))[0];
  return first && first.grid_import_total_kwh != null && String(first.local ?? "").slice(11, 16) < "01:30" ? first.grid_import_total_kwh : null;
};

/**
 * @param {string} date        "YYYY-MM-DD"
 * @param {Array} samples      that day's sample rows
 * @param {Array} nextSamples  the next day's sample rows (for the end-of-day counter)
 * @param {object|null} archive archive/<date>.json
 */
export function dailyRow(date, samples, nextSamples, archive) {
  const ss = archive?.sunsynk_5min ?? {};
  const c0 = firstCounter(samples), c1 = firstCounter(nextSamples);
  const grid = c0 != null && c1 != null && c1 >= c0 ? c1 - c0 : integrateKwh(ss.Grid);
  const pvSample = max(finite(samples.map((r) => r.pv_today_kwh)));
  const tankLog = finite((archive?.tank_temp_log ?? []).map((x) => x[1]));
  const tanks = tankLog.length ? tankLog : finite(samples.map((r) => r.tank_c));
  const socArch = finite(Object.values(ss.SOC ?? {}).map(Number));
  const socs = socArch.length ? socArch : finite(samples.map((r) => r.batt_soc));
  const sorted = [...samples].sort((a, b) => a.ts.localeCompare(b.ts));
  const lastPrepaid = sorted.filter((r) => Number.isFinite(r.prepaid?.balance_kwh)).at(-1);
  const hasGeyser = samples.some((r) => r.element != null);
  return {
    date,
    grid_import_kwh: r1(grid),
    pv_kwh: r1(integrateKwh(ss.PV) ?? pvSample),
    load_kwh: r1(integrateKwh(ss.Load)),
    battery_min_pct: min(socs),
    tank_min_c: min(tanks),
    tank_max_c: max(tanks),
    element_on_min: hasGeyser ? onMinutes(samples, (r) => r.element === "On") : null,
    pump_on_min: hasGeyser ? onMinutes(samples, (r) => r.pump === "On") : null,
    prepaid_end_kwh: lastPrepaid ? lastPrepaid.prepaid.balance_kwh : null,
  };
}

/** Insert or replace a date's line; the file stays one line per date, in date order. */
export function upsertDaily(text, row) {
  const byDate = new Map();
  for (const l of String(text ?? "").split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o.date) byDate.set(o.date, o); } catch { /* skip */ }
  }
  byDate.set(row.date, row);
  return [...byDate.keys()].sort().map((d) => JSON.stringify(byDate.get(d))).join("\n") + "\n";
}
