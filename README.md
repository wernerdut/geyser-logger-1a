# geyser-logger-1a

Read-only logger for the solar geyser (Geyserwise Max1, via Tuya Cloud) and the Sunsynk inverter at 1A Welgemeend. It never changes anything on either device.

- **snapshot** (every 30 min): tank, collector, pump, element, blocks, PV, load, grid, battery → `samples/YYYY-MM-DD.jsonl`
- **archive** (daily, 02:23 Cape Town): the previous day's full tank-temperature log from Tuya and the Sunsynk 5-minute curves → `archive/YYYY-MM-DD.json`, plus that day's summary line in `daily.jsonl`
- **state/latest.json** (every snapshot): current geyser, inverter, prepaid and open-alert picture, read by Zephyr's Dash. Unread fields are null.
- **daily.jsonl**: one line per day (grid import, PV, load, battery min, tank min/max, element/pump minutes, prepaid at day end), derived from samples, archive and the import counter only. `node logger.mjs backfill` rebuilds every past day; reruns replace a date's line, never duplicate it.

Tests: `npm test` (pure modules: prepaid.mjs, state.mjs, daily.mjs).

## Secrets (Settings → Secrets and variables → Actions)

`TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD`

Runs: about 1,500 Actions minutes a month, inside the free private-repo allowance. GitHub can delay or skip scheduled runs when busy, so expect occasional gaps.

## Control (since 27 Oct 2026)

Every snapshot run also enforces `schedule.json`. It may only set the geyser's **switch** and **Block1-4** (Werner's standing permission, 27 Oct 2026).

How the Geyserwise works: the element heats when (a display timer window is open **or** the switch is on) **and** the tank is below the current quarter's block (00-06, 06-12, 12-18, 18-24). The controller keeps the switch off and all blocks at `idle_block_c` (30), which also neutralises any display timers, and opens a window by switching on and raising the current block.

- **hot_by:** have the tank at `target_c` by `time`, starting no earlier than `earliest`. Start time comes from the tank reading, `tank_kwh_per_c` and `element_kw`, plus `margin_min`.
- **diverter:** inside `window`, when the battery is at `battery_on_pct` or more (solar is being thrown away), heat to `target_c`; stop below `battery_off_pct`.
- **control_enabled: false** stops all writes (kill switch).
- **Alerts** open an issue here (GitHub emails the owner): solar pump not moving water, or geyser unreachable for several runs.

Each sample row records the decision under `control` (reasons, desired state, writes, read-back).

## Prepaid electricity

`prepaid.json` is the ledger for meter 07147738442: every token (date, rand, kWh) and meter readings. The latest reading is the
anchor; balance = reading + tokens bought after it - grid import since then (the inverter's lifetime import counter, which
tracks the meter to within a few percent; the whole property, including Ansie's dwelling, is behind the inverter).

Each snapshot logs `prepaid: {balance_kwh, rate_kwh_day, days_left}` (rate = average of the last 7 complete days) and raises
`[power]` issues, closed automatically once the condition clears:

- **Buy this month's block-1 electricity**: nothing (or under 550 kWh) bought yet this calendar month and the meter won't last
  to the 1st plus 3 days. Fires as early as the 1st, because buying early costs nothing and a second token later in the month
  is all block 2.
- **Low, lasts to the 1st**: block 1 already bought this month, under 3 days left, but it reaches the 1st. Hold.
- **Low, buy a bridge**: same, but it runs out first. Suggests the smallest top-up (to the 1st plus 2 days) at block-2 rates.
- **Under a day left**: buy anything.
- **Tracker missing a token**: computed balance well below zero while the power is on.

Alerts are also sent to Werner on WhatsApp via Tannie (`POST /notify`) once the `TANNIE_NOTIFY_TOKEN` secret exists (same value as `NOTIFY_TOKEN` on the Railway tannie service).

### Grid, heartbeat and WhatsApp capture

- **Grid down**: the inverter reads no grid frequency. `[power] Grid down at 1A Welgemeend` with battery %, load and rough
  hours left; says "units probably ran out" if the prepaid balance is near zero. When the grid returns the issue closes and
  a "Grid back" WhatsApp follows. (30-minute resolution: short outages between runs are not seen.)
- **Heartbeat**: every snapshot POSTs `/heartbeat` to Tannie. Tannie WhatsApps Werner if none arrives for 2 hours, and
  again when they resume. This is what catches the logger itself dying.
- **Capture**: Werner forwards the token SMS, a screenshot of the purchase, or "meter 52" to Tannie. Tannie commits it to
  `prepaid.json` (commit message `ledger: ...`). That push triggers a run, which WhatsApps the new balance. Readings
  arrive without an inverter import total; the logger takes it from the nearest sample (within 60 minutes).

### Keep warm (irregular showers)

`schedule.json` `keep_warm`: between 06:00 and 21:00 the tank never sits below 55°C; when it does, the element reheats it to
65 (hysteresis: it stays on until the sensor reads ~63+ at the end of a run). From 08:00 to 16:00 the sun does the reheat: until 11:00 it
always waits (the collector is still warming up), after that only while the collector is working (pump on, or more than
5°C above the tank); a cloudy day falls back to the element. Below 40 the element heats regardless.
The fixed evening "hot by 19:00" was removed; the morning one stays because nights are idle. The surplus diverter
(battery full, 10:00-16:30) still tops the tank up to 65 for free. 65 is the ceiling without a mixing valve.
