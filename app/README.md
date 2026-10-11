# PLUVIA local evidence view

A location-first early warning view for New York City. You pick a place, PLUVIA watches it,
and when the public rain forecast looks like the days that put water on that spot before, it
warns you and prints the count the warning was built from. The flood history comes from dated
public snapshots in `data/nyc/`; the rain forecast and the 311 drainage complaints are read
live.

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

1. **Map.** Every FloodNet sensor in the snapshot. Marker size and colour show how many
   separate days that sensor recorded standing water. Click anywhere to drop a pin, use the
   locate button, or search by ZIP code, borough, street or sensor name.
2. **Watch this location.** The main action. PLUVIA keeps the pinned place, pulls the public
   seven day rain forecast for it, and checks each forecast day against that point's own
   measured record. A warning carries its arithmetic: how many comparable rain days there have
   been, how many of them flooded, and the typical depth in inches and centimetres.
3. **Live evidence on the card.** Current conditions, the heaviest stretch in the next 48 hours
   with its clock window, a 48 hour rain chart, and the 311 drainage complaints within 300 m
   read live from NYC Open Data.
4. **Email the warning.** Sends it through an AWS endpoint to an Amazon SNS topic.
5. **Nearest sensors.** Straight-line distance from your pin, or ranked by recorded flood days.
6. **Scenario check.** You choose a rain amount and a duration. PLUVIA counts the rain days
   since that sensor was installed, counts how many of those days it recorded water, and
   divides. The answer is a count of comparable days, not a modelled depth.
7. **Evidence card and replay.** For the selected events that carry a stored profile, the depth
   timeline plays back minute by minute from the recorded values.
8. **Show the records.** Every verdict can be expanded into the individual rows it was built
   from, with their dates, rainfall and depths.

## What it refuses to do

- No warning for shallow water. A place whose typical reading is under 2 in never raises one,
  however often it gets wet. The card says why instead.
- No modelled depth. Every depth shown was measured by a sensor. The deepest value anywhere in
  the dataset is 46.14 in / 117 cm, and nothing above it is ever produced.
- No live sensor feed. FloodNet does not publish a public API, so the flood history is a dated
  snapshot and the date is on screen. The forecast and the 311 complaints are the live parts.
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
