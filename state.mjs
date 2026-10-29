// state/latest.json: the logger's current picture for Dash (Zephyr reads it through the GitHub contents API).
// Pure logic only; logger.mjs supplies the row, the prepaid figures and the open alerts.

const n = (v) => (v === undefined ? null : v);

/** Cape Town local "YYYY-MM-DD HH:MM:SS" -> ISO with offset; a bare date stays a date. */
export function localToIso(local) {
  if (local == null) return null;
  const s = String(local);
  return s.length > 10 ? `${s.slice(0, 10)}T${s.slice(11, 19)}+02:00` : s.slice(0, 10);
}

/** Strip the "[power] " / "[geyser alert] " issue prefix. */
export const alertTitle = (title) => String(title).replace(/^\[[^\]]+\]\s*/, "");

/**
 * @param {object} p
 * @param {object} p.row        the snapshot row (fields missing when a device wasn't read)
 * @param {object|null} p.prepaid  {balance_kwh, est_days_left, month_to_date_kwh, block1_remaining_kwh, last_reading_at, last_token_at} or null
 * @param {Array<{key,title,since}>} p.alertsOpen
 */
export function latestState({ row, prepaid, alertsOpen }) {
  const on = (v) => (v == null ? null : v === "On");
  const p = prepaid ?? {};
  return {
    ts: row.ts,
    geyser: {
      tank_c: n(row.tank_c), collector_c: n(row.collector_c),
      element_on: on(row.element), pump_on: on(row.pump), switch_on: n(row.power),
    },
    inverter: {
      pv_w: n(row.pv_w), load_w: n(row.load_w), grid_w: n(row.grid_w), battery_pct: n(row.batt_soc),
      grid_up: row.grid_hz == null ? null : row.grid_hz >= 40,
    },
    prepaid: {
      balance_kwh: n(p.balance_kwh), est_days_left: n(p.est_days_left),
      month_to_date_kwh: n(p.month_to_date_kwh), block1_remaining_kwh: n(p.block1_remaining_kwh),
      last_reading_at: n(p.last_reading_at), last_token_at: n(p.last_token_at),
    },
    alerts_open: alertsOpen ?? [],
  };
}

/** Latest token's date/time in the ledger, ISO. */
export function lastTokenAt(ledger) {
  const ts = (ledger.tokens ?? []).map((t) => String(t.local ?? t.date)).sort();
  return ts.length ? localToIso(ts.at(-1)) : null;
}
