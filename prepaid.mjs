// Prepaid electricity tracker: balance from the inverter's lifetime grid-import counter, plus buy alerts that know about
// Cape Town's monthly blocks (the first 600 kWh bought each calendar month is block 1, the rest block 2).
// Pure logic only; logger.mjs supplies the readings and posts the alerts (GitHub issue + WhatsApp via Tannie /notify).

const r2 = (x) => Math.round(x * 100) / 100;
const ymd = (s) => String(s).slice(0, 10);

/** Most recent meter reading (the anchor) and every token keyed in after it. */
export function balanceOf(ledger, importTotalNow) {
  const readings = [...(ledger.readings ?? [])].sort((a, b) => String(a.local).localeCompare(String(b.local)));
  const anchor = readings.at(-1);
  if (!anchor || importTotalNow == null) return null;
  // A token counts if it was bought after the reading. Same-day tokens need a time to compare, else they are
  // assumed to be already on the meter when it was read (the safe side: it under-states the balance).
  const after = (ledger.tokens ?? []).filter((t) => {
    const tl = String(t.local ?? t.date);
    return tl.length > 10 ? tl > String(anchor.local) : ymd(tl) > ymd(anchor.local);
  });
  const added = after.reduce((s, t) => s + Number(t.kwh), 0);
  const used = importTotalNow - Number(anchor.import_total_kwh);
  return { balance: r2(Number(anchor.units) + added - used), anchor, added: r2(added), used: r2(used), estimated: !!anchor.estimated };
}

/** Average grid import per day over the last `n` complete days. `daily` is [{date, kwh}] in date order. */
export function dailyRate(daily, today, n = 7) {
  const done = daily.filter((d) => d.date < today && Number.isFinite(d.kwh)).slice(-n);
  if (!done.length) return null;
  return r2(done.reduce((s, d) => s + d.kwh, 0) / done.length);
}

/**
 * @param {object} p
 * @param {string} p.local   "YYYY-MM-DD HH:MM:SS" Cape Town time
 * @param {number} p.balance kWh on the meter (estimated)
 * @param {number} p.rate    kWh/day
 * @param {object} p.ledger  parsed prepaid.json
 * @param {boolean} p.estimated balance rests on an estimated reading
 */
export function prepaidAlerts({ local, balance, rate, ledger, estimated = false }) {
  const out = [];
  if (balance == null || !rate) return out;
  const T = ledger.tariff ?? {};
  const A = ledger.alerts ?? {};
  const lowDays = A.low_days ?? 3, buffer = A.buffer_days ?? 2;
  const b1 = T.block1_kwh ?? 600, p1 = T.block1_r_per_kwh ?? 3.5595, p2 = T.block2_r_per_kwh ?? 4.6906;

  const month = local.slice(0, 7);
  const [y, m, d] = local.slice(0, 10).split("-").map(Number);
  const hour = Number(local.slice(11, 13)) || 0;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysToFirst = daysInMonth - d + 1 - hour / 24; // until 00:00 on the 1st
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  const boughtKwh = (ledger.tokens ?? []).filter((t) => ymd(t.local ?? t.date).slice(0, 7) === month).reduce((s, t) => s + Number(t.kwh), 0);
  const block1Left = Math.max(0, b1 - boughtKwh);
  const daysLeft = balance / rate;
  const runsOut = (days) => (days < 1 ? `in about ${Math.max(0, Math.round(days * 24))} hours` : `in about ${days.toFixed(1)} days`);
  const status = `Meter ~${Math.max(0, Math.round(balance))} kWh${estimated ? " (estimated)" : ""}, using ~${Math.round(rate)} kWh/day, runs out ${runsOut(daysLeft)}.`;

  if (balance < -15) {
    out.push({
      key: "ledger",
      title: "[power] Tracker is missing a token or reading",
      body: `The tracker says the meter is ${Math.round(balance)} kWh below zero, but the power is still on, so a token was keyed in that the ledger doesn't know about. Send Claude the token SMS (kWh) or the meter reading.`,
    });
    return out;
  }

  // 1. Cheap units are still available this month and the meter won't last to the 1st (plus a margin): buy now.
  //    Buying early costs nothing (credit doesn't expire) and waiting risks a second, block-2 token later.
  if (block1Left >= 50 && daysLeft < daysToFirst + lowDays) {
    const kwh = Math.round(block1Left);
    out.push({
      key: `month-${month}`,
      title: `[power] ${monthName}: buy this month's block-1 electricity`,
      body: `${status}\n\nYou've bought ${Math.round(boughtKwh)} kWh this month, so ${kwh} kWh is still at the block-1 rate. ` +
        `Buy about R${Math.round(kwh * p1).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} now (≈${kwh} kWh at R${p1.toFixed(2)}). ` +
        `Anything beyond that this month costs R${p2.toFixed(2)}/kWh.`,
    });
  }

  // 2. Block 1 already used this month and the meter runs low before the 1st: buy only a bridge, the rest on the 1st.
  if (block1Left < 50 && daysLeft < lowDays) {
    if (daysLeft >= daysToFirst + 0.25) {
      out.push({
        key: "low-hold",
        title: "[power] Electricity low, but it lasts to the 1st",
        body: `${status}\n\nThe 1st is ${daysToFirst.toFixed(1)} days away. Hold off: a token now costs block-2 rates (R${p2.toFixed(2)}/kWh). Buy the month's token on the 1st.`,
      });
    } else {
      const kwh = Math.max(10, Math.ceil(rate * (daysToFirst + buffer) - balance));
      out.push({
        key: "low-bridge",
        title: "[power] Electricity low: buy a small bridge token",
        body: `${status}\n\nThis month's block-1 units are used up, so anything bought now is R${p2.toFixed(2)}/kWh. ` +
          `Buy just a bridge: about R${Math.ceil(kwh * p2)} (≈${kwh} kWh) gets you to the 1st with ${buffer} days' margin. Then buy the full token on the 1st.`,
      });
    }
  }

  // 3. Last call.
  if (daysLeft < 1) {
    out.push({ key: "critical", title: "[power] Under a day of electricity left", body: `${status}\n\nBuy now, any amount.` });
  }
  return out;
}

/**
 * Readings captured from WhatsApp arrive without the inverter's import total. Fill it from the logged sample nearest
 * in time (within 60 min). Readings that can't be resolved yet are dropped for this run (the previous anchor is used).
 * @param {object} ledger
 * @param {Array<{local:string, grid_import_total_kwh:number}>} rows  samples, any order
 */
export function resolveReadings(ledger, rows) {
  const toMs = (local) => Date.parse(String(local).replace(" ", "T") + "+02:00");
  const usable = rows.filter((r) => r && r.grid_import_total_kwh != null && r.local).map((r) => ({ t: toMs(r.local), v: r.grid_import_total_kwh }));
  const readings = (ledger.readings ?? []).flatMap((rd) => {
    if (rd.import_total_kwh != null) return [rd];
    const t = toMs(rd.local);
    let best = null;
    for (const u of usable) if (Math.abs(u.t - t) <= 60 * 60000 && (!best || Math.abs(u.t - t) < Math.abs(best.t - t))) best = u;
    return best ? [{ ...rd, import_total_kwh: best.v, resolved_from_sample: true }] : [];
  });
  return { ...ledger, readings };
}

/**
 * Grid outage: the inverter sees no grid frequency. If the meter is (nearly) empty, it's more likely the prepaid units
 * ran out than a municipal outage.
 */
export function gridAlerts({ row, balance, batteryKwh = 11.3, shutdownPct = 20 }) {
  if (row.grid_hz == null || row.grid_hz >= 40) return [];
  const soc = row.batt_soc, load = row.load_w;
  // Usable in an outage = above the inverter's battery shutdown level (batteryShutdownCap, 20% on this inverter).
  const stored = soc != null ? (Math.max(0, soc - shutdownPct) / 100) * batteryKwh : null;
  const hours = stored != null && load > 50 ? stored / (load / 1000) : null;
  const lines = [
    `At ${row.local.slice(11, 16)} the inverter sees no grid at 1A Welgemeend (frequency ${row.grid_hz} Hz). The house is on battery.`,
    `Battery ${soc ?? "?"}%${stored != null ? ` (~${stored.toFixed(1)} kWh usable)` : ""}, load ${load ?? "?"} W` +
      (hours != null ? `: roughly ${hours.toFixed(1)} h of backup at this load before the inverter shuts the battery off at ${shutdownPct}%.` : "."),
  ];
  if (balance != null && balance < 5) lines.push(`The prepaid tracker puts the meter at ~${Math.max(0, Math.round(balance))} kWh, so the units have probably run out. Buy and key in a token.`);
  else lines.push("Prepaid units look fine, so this is likely a municipal outage or a tripped breaker.");
  return [{ key: "grid", title: "[power] Grid down at 1A Welgemeend", body: lines.join("\n\n") }];
}
