# geyser-logger-1a

Read-only logger for the solar geyser (Geyserwise Max1, via Tuya Cloud) and the Sunsynk inverter at 1A Welgemeend. It never changes anything on either device.

- **snapshot** (every 30 min): tank, collector, pump, element, blocks, PV, load, grid, battery → `samples/YYYY-MM-DD.jsonl`
- **archive** (daily, 02:23 Cape Town): the previous day's full tank-temperature log from Tuya and the Sunsynk 5-minute curves → `archive/YYYY-MM-DD.json`

## Secrets (Settings → Secrets and variables → Actions)

`TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD`

Runs: about 1,500 Actions minutes a month, inside the free private-repo allowance. GitHub can delay or skip scheduled runs when busy, so expect occasional gaps.
