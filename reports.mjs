// WhatsApp reports for Werner: weekly (Sunday 18:00), monthly (1st, 10:00) and "doesn't look right" notices
// (usage spike, cold morning, battery not filling). Pure logic only; logger.mjs reads the files, sends via Tannie
// and records what was sent in the sample row (row.notices) so nothing goes out twice.
//
// Inputs: daily.jsonl rows ({date, grid_import_kwh, pv_kwh, prepaid_end_kwh, ...}) and per-day sample rows.

const r0 = (x) => Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const fin = (xs) => xs.filter((x) => Number.isFinite(x));
const median = (xs) => {
  const s = fin(xs).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rand = (x) => `R${r0(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const DAY = 24 * 3600 * 1000;

export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** Per-day facts from that day's samples. */
export function dayStats(samples) {
  const rows = [...samples].filter((r) => r.local).sort((a, b) => a.local.localeCompare(b.local));
  let draws = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].tank_c, b = rows[i].tank_c;
    if (Number.isFinite(a) && Number.isFinite(b) && a - b >= 6) draws++;
  }
  const t = (r) => r.local.slice(11, 16);
  const dayTanks = fin(rows.filter((r) => t(r) >= "06:00" && t(r) <= "22:00").map((r) => r.tank_c));
  const at630 = rows.find((r) => t(r) >= "06:30" && t(r) < "07:30" && Number.isFinite(r.tank_c));
  const heatRan = rows.some((r) => t(r) >= "01:30" && t(r) < "06:30" && r.power === true && (r.blocks ?? []).some((b) => b >= 60));
  // Runs in the solar window with the controller heating (switch on, a block at 60+): geyser using the day's sun.
  const sunHeatRuns = rows.filter((r) => t(r) >= "09:00" && t(r) < "16:00" && r.power === true && (r.blocks ?? []).some((b) => b >= 60)).length;
  const nightCounter = rows.filter((r) => t(r) < "06:05" && Number.isFinite(r.grid_import_total_kwh));
  const nightGrid = nightCounter.length > 1 ? nightCounter.at(-1).grid_import_total_kwh - nightCounter[0].grid_import_total_kwh : null;
  return {
    draws,
    tank_day_min: dayTanks.length ? Math.min(...dayTanks) : null,
    tank_0630: at630 ? at630.tank_c : null,
    morning_heat_ran: heatRan,
    battery_max: fin(rows.map((r) => r.batt_soc)).length ? Math.max(...fin(rows.map((r) => r.batt_soc))) : null,
    night_grid_kwh: nightGrid == null ? null : r1(nightGrid),
    sun_heat_runs: sunHeatRuns,
    errors: rows.filter((r) => r.errors?.length).length,
    alerts: [...new Set(rows.flatMap((r) => r.alerts ?? []))],
  };
}

function block(days, statsByDate, factor) {
  const g = fin(days.map((d) => d.grid_import_kwh));
  const pv = fin(days.map((d) => d.pv_kwh));
  const st = days.map((d) => statsByDate[d.date]).filter(Boolean);
  return {
    n: days.length,
    grid: g.length ? sum(g) * factor : null,
    pv: pv.length ? sum(pv) : null,
    draws: sum(st.map((s) => s.draws)),
    coldDays: st.filter((s) => s.tank_day_min != null && s.tank_day_min < 45).length,
    errors: sum(st.map((s) => s.errors)),
    alerts: [...new Set(st.flatMap((s) => s.alerts))],
  };
}

const ALERT_NAMES = {
  pump: "solar pump", unreachable: "geyser offline", grid: "grid down", critical: "under a day of electricity",
  "low-bridge": "electricity low (bridge)", "low-hold": "electricity low", ledger: "ledger missing a token",
};
const alertList = (keys) => keys.map((k) => (k.startsWith("month-") ? null : ALERT_NAMES[k] ?? k)).filter(Boolean);

function prepaidLine(prepaid, today) {
  if (!prepaid || !Number.isFinite(prepaid.balance_kwh)) return "Meter: unknown.";
  const left = prepaid.days_left;
  const until = Number.isFinite(left) ? `, lasts to about ${shortDate(addDays(today, Math.floor(left)))} at ~${r0(prepaid.rate_kwh_day)} kWh/day` : "";
  return `Meter: ${r0(prepaid.balance_kwh)} kWh${until}.`;
}

/**
 * Weekly WhatsApp: the 7 complete days ending yesterday, against the 7 before.
 * @param {object} p {today, daily: [...daily rows], statsByDate, prepaid: row.prepaid, tariff, factor}
 */
export function weeklyText({ today, daily, statsByDate, prepaid, tariff = {}, factor = 1 }) {
  const end = addDays(today, -1), start = addDays(today, -7);
  const pick = (a, b) => daily.filter((d) => d.date >= a && d.date <= b);
  const cur = block(pick(start, end), statsByDate, factor);
  const prev = block(pick(addDays(start, -7), addDays(start, -1)), statsByDate, factor);
  const p1 = tariff.block1_r_per_kwh ?? 3.5595;
  const lines = [`*Home energy week* (${shortDate(start)} to ${shortDate(end)})`, ""];
  if (cur.grid != null) {
    const vs = prev.grid != null && prev.n >= 5 ? `, last week ${r0(prev.grid)} kWh` : "";
    lines.push(`Grid: ${r0(cur.grid)} kWh (≈${rand(cur.grid * p1)})${vs}.`);
  }
  if (cur.pv != null) lines.push(`Solar: ${r0(cur.pv)} kWh.`);
  lines.push(`Hot water: ${cur.draws} big draws` + (prev.n >= 5 ? ` (last week ${prev.draws})` : "") +
    (cur.coldDays ? `; tank under 45°C on ${cur.coldDays} day${cur.coldDays > 1 ? "s" : ""}.` : "; never under 45°C in the day."));
  lines.push(prepaidLine(prepaid, today));
  const al = alertList(cur.alerts);
  lines.push(al.length ? `Alerts this week: ${al.join(", ")}.` : "No alerts this week.");
  if (cur.errors) lines.push(`${cur.errors} logger run${cur.errors > 1 ? "s" : ""} had a brief read error (self-recovered).`);
  return lines.join("\n");
}

/**
 * Monthly WhatsApp on the 1st: the previous calendar month.
 * @param {object} p {today, daily, statsByDate, prepaid, ledger, factor}
 */
export function monthlyText({ today, daily, statsByDate, prepaid, ledger = {}, factor = 1 }) {
  const prevYm = addDays(today.slice(0, 8) + "01", -1).slice(0, 7);
  const prev2Ym = addDays(prevYm + "-01", -1).slice(0, 7);
  const cur = block(daily.filter((d) => d.date.startsWith(prevYm)), statsByDate, factor);
  const before = block(daily.filter((d) => d.date.startsWith(prev2Ym)), statsByDate, factor);
  const tokens = (ledger.tokens ?? []).filter((t) => String(t.local ?? t.date).startsWith(prevYm));
  const spent = sum(fin(tokens.map((t) => Number(t.rand))));
  const bought = sum(fin(tokens.map((t) => Number(t.kwh))));
  const lines = [`*${monthLabel(prevYm)}: home energy*`, ""];
  if (cur.grid != null) {
    const perDay = cur.n ? cur.grid / cur.n : null;
    const vs = before.grid != null && before.n >= 20 ? `; ${monthLabel(prev2Ym).split(" ")[0]} ${r0(before.grid)} kWh` : "";
    const daysInMonth = new Date(Date.UTC(Number(prevYm.slice(0, 4)), Number(prevYm.slice(5, 7)), 0)).getUTCDate();
    const partial = cur.n < daysInMonth ? ` (${cur.n} of ${daysInMonth} days logged)` : "";
    lines.push(`Grid: ${r0(cur.grid)} kWh${partial}, ~${r1(perDay)} kWh/day${vs}.`);
  }
  if (cur.pv != null) lines.push(`Solar: ${r0(cur.pv)} kWh.`);
  if (tokens.length) lines.push(`Bought: ${rand(spent)} for ${r0(bought)} kWh (${tokens.length} token${tokens.length > 1 ? "s" : ""}, ≈R${(spent / bought).toFixed(2)}/kWh).`);
  lines.push(`Hot water: ${cur.draws} big draws; tank under 45°C in the day on ${cur.coldDays} day${cur.coldDays === 1 ? "" : "s"}.`);
  lines.push(prepaidLine(prepaid, today));
  const al = alertList(cur.alerts);
  if (al.length) lines.push(`Alerts during the month: ${al.join(", ")}.`);
  return lines.join("\n");
}

/**
 * "Doesn't look right" checks, run once a day after 07:00. Returns [{key, text}].
 * @param {object} p {today, daily, statsByDate, factor}
 */
export function anomalies({ today, daily, statsByDate, factor = 1 }) {
  const out = [];
  const y = addDays(today, -1);
  const yd = daily.find((d) => d.date === y);
  const ys = statsByDate[y], ts = statsByDate[today];
  const hist = daily.filter((d) => d.date < y && d.date >= addDays(y, -14));
  const histStats = hist.map((d) => statsByDate[d.date]).filter(Boolean);

  // 1. Usage spike: yesterday's grid more than double the two-week normal (and at least 8 kWh).
  const norm = median(hist.map((d) => d.grid_import_kwh));
  if (yd && Number.isFinite(yd.grid_import_kwh) && norm != null && hist.length >= 7 &&
      yd.grid_import_kwh >= 8 && yd.grid_import_kwh > 2 * norm) {
    const why = [];
    const nd = median(histStats.map((s) => s.draws));
    if (ys && nd != null && ys.draws >= Math.max(4, 2 * nd)) why.push(`${ys.draws} big hot-water draws (normal ~${r0(nd)})`);
    const nn = median(histStats.map((s) => s.night_grid_kwh));
    if (ys && ys.night_grid_kwh != null && nn != null && ys.night_grid_kwh > Math.max(3, 2 * nn)) why.push(`${ys.night_grid_kwh} kWh between midnight and 06:00 (normal ~${r1(nn)})`);
    const np = median(hist.map((d) => d.pv_kwh));
    if (Number.isFinite(yd.pv_kwh) && np != null && yd.pv_kwh < 0.6 * np) why.push(`little sun (${r0(yd.pv_kwh)} kWh solar, normal ~${r0(np)})`);
    out.push({
      key: `spike-${y}`,
      text: `*Electricity use spiked ${dayLabel(y)}*\n\n${r0(yd.grid_import_kwh * factor)} kWh from the grid, about ${r1(yd.grid_import_kwh / norm)}× the two-week normal of ${r0(norm)} kWh.` +
        (why.length ? `\n\nLikely: ${why.join("; ")}.` : "\n\nNo obvious cause in hot water, night use or sun: something else drew power. Worth a look at what was left on."),
    });
  }

  // 2. Cold morning: the morning heat ran, but the tank was under 55°C at 06:30.
  if (ts && ts.morning_heat_ran && ts.tank_0630 != null && ts.tank_0630 < 55) {
    out.push({
      key: `cold-${today}`,
      text: `*Geyser cold this morning*\n\nThe tank read ${ts.tank_0630}°C at 06:30 even though the morning heat ran. ` +
        "Possible causes: a lot of hot water used overnight, the element or its thermostat, or the controller didn't get through. Claude can check the log.",
    });
  }

  // 3. Battery not filling on a sunny day. Skipped when the geyser heated for 1.5 h+ in the solar window: that is
  //    the sun going into hot water (heavy-use days), not a charging fault.
  if (yd && Number.isFinite(yd.pv_kwh) && yd.pv_kwh >= 18 && ys && ys.battery_max != null && ys.battery_max < 90 &&
      (ys.sun_heat_runs ?? 0) < 3) {
    out.push({
      key: `battery-${y}`,
      text: `*Battery didn't fill ${dayLabel(y)}*\n\n${r0(yd.pv_kwh)} kWh of solar, yet the battery peaked at ${ys.battery_max}%. ` +
        "On a day that sunny it normally reaches 100%. Could be heavy daytime use, or a battery/inverter charging problem if it repeats.",
    });
  }
  return out;
}
