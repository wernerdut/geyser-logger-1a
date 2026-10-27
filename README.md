# geyser-logger-1a

Read-only logger for the solar geyser (Geyserwise Max1, via Tuya Cloud) and the Sunsynk inverter at 1A Welgemeend. It never changes anything on either device.

- **snapshot** (every 30 min): tank, collector, pump, element, blocks, PV, load, grid, battery → `samples/YYYY-MM-DD.jsonl`
- **archive** (daily, 02:23 Cape Town): the previous day's full tank-temperature log from Tuya and the Sunsynk 5-minute curves → `archive/YYYY-MM-DD.json`

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
