import { test } from "node:test";
import assert from "node:assert/strict";
import { monthBlock, estDaysLeft, prepaidAlerts } from "../prepaid.mjs";
import { latestState, localToIso, lastTokenAt, alertTitle } from "../state.mjs";
import { dailyRow, upsertDaily, integrateKwh, onMinutes } from "../daily.mjs";

const ledger = { tariff: { block1_kwh: 600 }, tokens: [{ date: "2026-10-07", kwh: 677.7 }, { date: "2026-09-17", kwh: 677.7 }, { local: "2026-10-20 08:00:00", kwh: 100 }] };

test("monthBlock counts only that month's tokens", () => {
  assert.deepEqual(monthBlock(ledger, "2026-10"), { boughtKwh: 777.7, block1Left: 0 });
  assert.deepEqual(monthBlock({ tokens: [] }, "2026-11"), { boughtKwh: 0, block1Left: 600 });
});

test("prepaidAlerts still uses the block logic", () => {
  const a = prepaidAlerts({ local: "2026-11-02 08:00:00", balance: 20, rate: 14, ledger });
  assert.equal(a[0].key, "month-2026-11");
});

test("estDaysLeft needs 3 complete days and ignores today", () => {
  const d = [{ date: "2026-10-26", kwh: 10 }, { date: "2026-10-27", kwh: 20 }, { date: "2026-10-28", kwh: 30 }, { date: "2026-10-29", kwh: 99 }];
  assert.equal(estDaysLeft(100, d, "2026-10-29"), 5);
  assert.equal(estDaysLeft(100, d.slice(1), "2026-10-29"), null);
  assert.equal(estDaysLeft(null, d, "2026-10-29"), null);
});

test("latestState: full shape, nulls not omissions", () => {
  const s = latestState({ row: { ts: "2026-10-29T01:43:25Z", tank_c: 63, element: "On", pump: "Off", power: true, grid_hz: 49.8 }, prepaid: null, alertsOpen: [] });
  assert.deepEqual(s, {
    ts: "2026-10-29T01:43:25Z",
    geyser: { tank_c: 63, collector_c: null, element_on: true, pump_on: false, switch_on: true },
    inverter: { pv_w: null, load_w: null, grid_w: null, battery_pct: null, grid_up: true },
    prepaid: { balance_kwh: null, est_days_left: null, month_to_date_kwh: null, block1_remaining_kwh: null, last_reading_at: null, last_token_at: null },
    alerts_open: [],
  });
  assert.equal(latestState({ row: { ts: "x", grid_hz: 0 } }).inverter.grid_up, false);
});

test("state helpers", () => {
  assert.equal(localToIso("2026-10-28 06:12:56"), "2026-10-28T06:12:56+02:00");
  assert.equal(localToIso("2026-10-07"), "2026-10-07");
  assert.equal(lastTokenAt(ledger), "2026-10-20T08:00:00+02:00");
  assert.equal(alertTitle("[power] Grid down at 1A Welgemeend"), "Grid down at 1A Welgemeend");
});

test("integrateKwh: positive power only, 5-minute steps", () => {
  assert.equal(integrateKwh({ "00:00": 1200, "00:05": 1200, "00:10": -500 }), 0.2 + 0);
  assert.equal(integrateKwh(null), null);
});

test("onMinutes weighs each sample by the gap to the next", () => {
  const rows = [{ ts: "2026-10-28T00:00:00Z", e: 1 }, { ts: "2026-10-28T00:30:00Z", e: 0 }, { ts: "2026-10-28T01:00:00Z", e: 1 }];
  assert.equal(onMinutes(rows, (r) => r.e === 1), 60);
  assert.equal(onMinutes([], () => true), null);
});

test("dailyRow prefers the import counter and falls back to the archive", () => {
  const s = [
    { ts: "2026-10-27T22:07:00Z", local: "2026-10-28 00:07:00", grid_import_total_kwh: 100, tank_c: 50, element: "On", pump: "Off", batt_soc: 40, prepaid: { balance_kwh: 60 } },
    { ts: "2026-10-28T21:37:00Z", grid_import_total_kwh: 112, tank_c: 60, element: "Off", pump: "Off", batt_soc: 30, prepaid: { balance_kwh: 48 } },
  ];
  const next = [{ ts: "2026-10-28T22:07:00Z", local: "2026-10-29 00:07:00", grid_import_total_kwh: 114 }];
  const r = dailyRow("2026-10-28", s, next, null);
  assert.equal(r.grid_import_kwh, 14);
  assert.equal(r.tank_min_c, 50); assert.equal(r.tank_max_c, 60); assert.equal(r.battery_min_pct, 30);
  assert.equal(r.prepaid_end_kwh, 48); assert.equal(r.load_kwh, null);
  const late = [{ ...s[0], local: "2026-10-28 22:00:00", ts: "2026-10-28T20:00:00Z" }];
  assert.equal(dailyRow("2026-10-28", late, next, null).grid_import_kwh, null);
  const arch = { tank_temp_log: [["x", 40], ["y", 65]], sunsynk_5min: { Grid: { "00:00": 1200, "00:05": 1200 }, SOC: { "00:00": 22 } } };
  const r2 = dailyRow("2026-10-28", [], [], arch);
  assert.equal(r2.grid_import_kwh, 0.2); assert.equal(r2.tank_min_c, 40); assert.equal(r2.battery_min_pct, 22);
  assert.equal(r2.element_on_min, null);
});

test("upsertDaily never duplicates a date", () => {
  let t = upsertDaily("", { date: "2026-10-28", a: 1 });
  t = upsertDaily(t, { date: "2026-10-27", a: 2 });
  t = upsertDaily(t, { date: "2026-10-28", a: 3 });
  assert.deepEqual(t.trim().split("\n").map((l) => JSON.parse(l)), [{ date: "2026-10-27", a: 2 }, { date: "2026-10-28", a: 3 }]);
});
