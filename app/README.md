# PLUVIA local evidence view

A location-first view of what New York City's FloodNet sensors actually recorded, built
entirely from dated public snapshots stored in `data/nyc/`.

## Run it

```
python3 app/build_card_data.py
python3 -m http.server 8000
```

Then open <http://localhost:8000/app/index.html>.

The page loads `card_data.json` over HTTP on its own. If you open `index.html` straight from
disk the browser blocks that read, so the page falls back to a file picker. Both paths show
exactly the same data.

## What the page does

1. **Map.** Every FloodNet sensor in the snapshot, drawn on OpenStreetMap tiles. Marker size
   and colour show how many separate days that sensor recorded standing water. Click anywhere
   to drop a pin, or search by ZIP code, borough, street or sensor name.
2. **Nearest sensors.** Straight-line distance from your pin, or ranked by recorded flood days.
3. **Scenario check.** You choose a rain amount and a duration. PLUVIA counts the rain days
   since that sensor was installed, counts how many of those days it recorded water, and
   divides. Nothing is modelled, estimated or predicted.
4. **Evidence card and replay.** For the selected events that carry a stored profile, the depth
   timeline plays back minute by minute from the recorded values.
5. **Show the records.** Every verdict can be expanded into the individual rows it was built
   from, with their dates, rainfall and depths.

## What it refuses to do

- No forecast and no warning. The scenario is a what-if against recorded history.
- Tidally influenced sensors are refused a rainfall verdict, because their water is driven by
  the tide. The page says so instead of returning a confident wrong number.
- A sensor with no recorded history gets `Verdict unavailable`, never an implied all-clear.
- Missing values render as `[UNKNOWN]` or `Unavailable`. Nothing is zero-filled.

## Data inputs

| File | What it carries |
| --- | --- |
| `data/nyc/raw/floodnet_network_*.json` | Sensor deployment metadata, dataset `kb2e-tjy3` |
| `data/nyc/raw/floodnet_events_full_*.json` | Recorded flood events, dataset `aq7i-eu5q` |
| `data/nyc/raw/floodnet_replay_profiles_*.json` | Minute-by-minute depth profiles |
| `data/nyc/raw/nyc_daily_rain_*.json` | Daily rainfall and rain hours, Open-Meteo archive |
| `data/nyc/raw/drainage_311_*.json` | Optional 311 drainage complaints, dataset `erm2-nwe9` |
| `data/nyc/derived/drainage_near_sensors_*.json` | Small join written by the build script |
| `app/nyc_boroughs.geojson` | Simplified borough outlines, drawn when tiles are absent |

The 311 export is large, so the build script reads it once and writes the small derived file
next to it. Only the derived file needs to be committed.

`vendor/leaflet/` holds Leaflet 1.9.4 under its own BSD-2-Clause licence. Street tiles are
fetched live from OpenStreetMap and are context only; every number on the page comes from the
local snapshots.
