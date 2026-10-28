// Geyser controller: decides the desired switch + block settings from schedule.json and the latest readings.
// Pure decision logic lives in decide(); applying writes and alerts is done by the caller (logger.mjs).
//
// How the Geyserwise works (see README): the element heats when (a display timer window is open OR the switch is on)
// AND the tank sensor is below the current quarter's block temperature. This controller keeps the switch off and all
// blocks at the idle value (so leftover display timers can never heat), and opens a window by switching on and raising
// the block(s) that cover "now" and the next run.

export const BLOCK_CODES = ["Block1", "Block2", "Block3", "Block4"]; // 00-06, 06-12, 12-18, 18-24
export const ALLOWED_CODES = new Set(["switch", ...BLOCK_CODES]);

export const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};
const quarter = (min) => Math.floor((((min % 1440) + 1440) % 1440) / 360);

/**
 * @param {object} p
 * @param {number} p.minute     minutes since local midnight (Africa/Johannesburg)
 * @param {object} p.schedule   parsed schedule.json
 * @param {number|null} p.tank  tank sensor °C
 * @param {number|null} p.soc   battery %
 * @param {boolean|null} p.switchOn current geyser switch state
 * @param {Array<number|null>} p.blocks current Block1-4
 * @param {number|null} [p.collector] solar collector °C
 * @param {string|null} [p.pump]  solar pump "On"/"Off"
 */
export function decide({ minute, schedule, tank, soc, switchOn, blocks, collector = null, pump = null }) {
  const S = schedule;
  const idle = S.idle_block_c ?? 30;
  const cadence = S.cadence_min ?? 30;
  const reasons = [];
  let target = null;

  // 1. Hot-by events: start just early enough to reach the target by the deadline.
  for (const e of S.hot_by ?? []) {
    const T = toMin(e.time);
    const earliest = toMin(e.earliest ?? e.time);
    if (minute < earliest || minute >= T) continue;
    const t = Number(e.target_c);
    const need = tank == null ? Infinity : Math.max(0, t - tank) * (S.tank_kwh_per_c ?? 0.29);
    const runMin = need === Infinity ? Infinity : (need / (S.element_kw ?? 3.4)) * 60 + (S.margin_min ?? 15);
    const start = Math.max(earliest, T - runMin);
    // Already heating for this event: stay on until the deadline. The sensor sits next to the element and
    // overstates the tank while heating, so re-deciding from it mid-heat would switch off too early.
    const latched = switchOn === true && blocks[quarter(minute)] >= t;
    if (latched || (need > 0 && minute + cadence > start)) {
      target = Math.max(target ?? 0, t);
      reasons.push(`${e.name}: hot by ${e.time} (need ~${need === Infinity ? "?" : need.toFixed(1)} kWh, start ${fmt(start)})`);
    }
  }

  // 2. Keep warm: for irregular showers, never let the tank sit below min_c during the day. Once triggered it heats
  //    until the sensor reads about the target at the end of a run (hysteresis), so it doesn't chatter at the floor.
  //    In the solar window the collector gets first go while it is actually working (pump on or collector hotter than
  //    the tank), unless the tank falls below solar_wait_min_c.
  const K = S.keep_warm;
  if (K?.enabled && tank != null) {
    const [a, b] = K.window.map(toMin);
    if (minute >= a && minute < b) {
      const t = Number(K.target_c);
      const latched = switchOn === true && blocks[quarter(minute)] >= t && tank < t - 2;
      let wanted = latched || tank < Number(K.min_c);
      const sw = K.solar_first;
      const solarWorking = pump === "On" || (collector != null && collector > tank + 5);
      if (wanted && sw && solarWorking && tank >= Number(K.solar_wait_min_c ?? 0)) {
        const [sa, sb] = sw.map(toMin);
        if (minute >= sa && minute < sb && !latched) {
          wanted = false;
          reasons.push(`keep warm: tank ${tank}°C, solar collector working, letting it heat first`);
        }
      }
      if (wanted) {
        target = Math.max(target ?? 0, t);
        reasons.push(`keep warm: tank ${tank}°C ${latched ? "(reheating)" : `< ${K.min_c}°C`} -> ${t}°C`);
      } else if (!reasons.some((r) => r.startsWith("keep warm"))) {
        reasons.push(`keep warm: tank ${tank}°C ok`);
      }
    }
  }

  // 3. Surplus diverter: battery full means solar is being thrown away, so store it as heat.
  const D = S.diverter;
  if (D?.enabled && soc != null) {
    const [a, b] = D.window.map(toMin);
    if (minute >= a && minute < b) {
      const t = Number(D.target_c);
      const latched = switchOn === true && blocks[quarter(minute)] === t && soc >= D.battery_off_pct;
      if (latched || soc >= D.battery_on_pct) {
        target = Math.max(target ?? 0, t);
        reasons.push(`surplus: battery ${soc}% -> store heat to ${t}°C`);
      }
    }
  }

  const desired = { switch: target != null, blocks: [idle, idle, idle, idle] };
  if (target != null) {
    // Cover this quarter and the one the next run may fall into, so a quarter boundary never drops the target.
    desired.blocks[quarter(minute)] = target;
    desired.blocks[quarter(minute + cadence + 5)] = target;
  }
  if (target == null && !reasons.length) reasons.push("idle: no window open");
  return { desired, reasons };
}

export function diff(desired, current) {
  const writes = [];
  if (current.switchOn !== desired.switch) writes.push({ code: "switch", value: desired.switch });
  desired.blocks.forEach((v, i) => {
    if (current.blocks[i] !== v) writes.push({ code: BLOCK_CODES[i], value: v });
  });
  return writes;
}

const fmt = (min) => {
  if (!Number.isFinite(min)) return "?";
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// ---------- watchdog ----------
export function checkAlerts({ row, recentRows, schedule }) {
  const A = schedule.alerts ?? {};
  const out = [];
  if (row.collector_c != null && row.tank_c != null && row.pump === "On" &&
      row.collector_c - row.tank_c >= (A.pump_gap_c ?? 40)) {
    out.push({
      key: "pump",
      title: "[geyser alert] Solar pump not moving water",
      body: `At ${row.local} the collector read ${row.collector_c}°C against a tank of ${row.tank_c}°C with the pump on. ` +
        `A gap that large means water isn't circulating (pump failure, blockage or airlock). Last time this showed as E9 on the display.`,
    });
  }
  const n = A.geyser_unreachable_runs ?? 4;
  const lastN = [...recentRows, row].slice(-n);
  if (lastN.length === n && lastN.every((r) => (r.errors ?? []).some((e) => e.startsWith("geyser")))) {
    out.push({
      key: "unreachable",
      title: "[geyser alert] Geyser not reachable",
      body: `The last ${n} runs (up to ${row.local}) could not read the geyser. Check its Wi-Fi, power, or the Tuya cloud project (trial renewal).`,
    });
  }
  return out;
}
