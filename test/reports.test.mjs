import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStats, weeklyText, monthlyText, anomalies, addDays } from "../reports.mjs";

const row = (local, o = {}) => ({ local, ts: local.replace(" ", "T") + "+02:00", ...o });

test("dayStats: draws, 06:30 tank, morning heat, night grid", () => {
  const s = dayStats([
    row("2026-11-10 00:00:00", { tank_c: 50, grid_import_total_kwh: 100 }),
    row("2026-11-10 03:00:00", { tank_c: 48, power: true, blocks: [65, 30, 30, 30], grid_import_total_kwh: 103 }),
    row("2026-11-10 06:00:00", { tank_c: 62, grid_import_total_kwh: 108 }),
    row("2026-11-10 06:30:00", { tank_c: 61, batt_soc: 25 }),
    row("2026-11-10 07:30:00", { tank_c: 44, batt_soc: 30 }),
    row("2026-11-10 13:00:00", { tank_c: 60, batt_soc: 100, errors: ["x"], alerts: ["pump"] }),
  ]);
  assert.equal(s.draws, 1);
  assert.equal(s.tank_0630, 61);
  assert.equal(s.morning_heat_ran, true);
  assert.equal(s.night_grid_kwh, 8);
  assert.equal(s.tank_day_min, 44);
  assert.equal(s.battery_max, 100);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.alerts, ["pump"]);
});

const mkDaily = (start, n, f) => Array.from({ length: n }, (_, i) => ({ date: addDays(start, i), ...f(i) }));

test("weekly text compares with the previous week", () => {
  const daily = mkDaily("2026-11-01", 14, (i) => ({ grid_import_kwh: i < 7 ? 7 : 14, pv_kwh: 20 }));
  const statsByDate = Object.fromEntries(daily.map((d, i) => [d.date, { draws: i < 7 ? 2 : 6, tank_day_min: i === 10 ? 40 : 50, errors: 0, alerts: [] }]));
  const t = weeklyText({ today: "2026-11-15", daily, statsByDate, prepaid: { balance_kwh: 460, days_left: 33, rate_kwh_day: 14 }, factor: 1 });
  assert.match(t, /Grid: 98 kWh \(≈R349\), last week 49 kWh/);
  assert.match(t, /42 big draws \(last week 14\); tank under 45°C on 1 day/);
  assert.match(t, /Meter: 460 kWh, lasts to about 18 Dec/);
  assert.match(t, /No alerts this week/);
});

test("monthly text covers the previous calendar month and its tokens", () => {
  const daily = mkDaily("2026-11-01", 30, () => ({ grid_import_kwh: 10, pv_kwh: 20 }));
  const t = monthlyText({ today: "2026-12-01", daily, statsByDate: {}, prepaid: null,
    ledger: { tokens: [{ date: "2026-11-01", rand: 2150, kwh: 603.1 }, { date: "2026-10-30", rand: 100, kwh: 21.4 }] } });
  assert.match(t, /November 2026: home energy/);
  assert.match(t, /Grid: 300 kWh, ~10 kWh\/day/);
  assert.match(t, /Bought: R2,150 for 603 kWh \(1 token/);
});

test("anomalies: spike with cause, cold morning, battery not filling, and quiet days stay quiet", () => {
  const daily = mkDaily("2026-11-01", 15, (i) => ({ grid_import_kwh: i === 14 ? 20 : 7, pv_kwh: i === 14 ? 25 : 20 }));
  const statsByDate = Object.fromEntries(daily.map((d, i) => [d.date, { draws: i === 14 ? 10 : 2, night_grid_kwh: 1, battery_max: i === 14 ? 70 : 100 }]));
  statsByDate["2026-11-16"] = { morning_heat_ran: true, tank_0630: 48 };
  const a = anomalies({ today: "2026-11-16", daily, statsByDate });
  assert.deepEqual(a.map((x) => x.key), ["spike-2026-11-15", "cold-2026-11-16", "battery-2026-11-15"]);
  assert.match(a[0].text, /10 big hot-water draws/);
  const quiet = mkDaily("2026-11-01", 15, () => ({ grid_import_kwh: 7, pv_kwh: 20 }));
  const qs = Object.fromEntries(quiet.map((d) => [d.date, { draws: 2, night_grid_kwh: 1, battery_max: 100 }]));
  qs["2026-11-16"] = { morning_heat_ran: true, tank_0630: 60 };
  assert.deepEqual(anomalies({ today: "2026-11-16", daily: quiet, statsByDate: qs }), []);
});

test("cold morning: an early shower after the tank got hot is not a fault (20 Nov)", () => {
  const s = dayStats([
    row("2026-11-20 02:54:00", { tank_c: 49, power: true, blocks: [65, 30, 30, 30] }),
    row("2026-11-20 05:00:00", { tank_c: 59, power: true, blocks: [65, 30, 30, 30] }),
    row("2026-11-20 06:00:00", { tank_c: 60 }),
    row("2026-11-20 06:30:00", { tank_c: 50 }),
  ]);
  assert.equal(s.tank_morning_peak, 60);
  const quiet = mkDaily("2026-11-06", 14, () => ({ grid_import_kwh: 7, pv_kwh: 20 }));
  const sb = Object.fromEntries(quiet.map((d) => [d.date, { draws: 2, night_grid_kwh: 1, battery_max: 100 }]));
  assert.deepEqual(anomalies({ today: "2026-11-20", daily: quiet, statsByDate: { ...sb, "2026-11-20": s } }), []);
  const cold = { ...s, tank_morning_peak: 50 };
  assert.deepEqual(anomalies({ today: "2026-11-20", daily: quiet, statsByDate: { ...sb, "2026-11-20": cold } }).map((x) => x.key), ["cold-2026-11-20"]);
});
