# PLUVIA

**Know the Impact, Not Just the Rain.**

A hyperlocal rain-impact evidence project for the Heat and Water track of the
AWS Environmental Hacks event (Event 02, 2026). Instead of predicting flooding,
PLUVIA shows what one storm actually did to one place, assembled from verified,
dated public data.

## What this repo holds

Build window 8 to 11 October 2026. Current state, stated honestly:

| Piece | Status |
|---|---|
| NYC data snapshots, QC log, manifest, replay candidate selection | done and verified |
| Local evidence-card demo (one frozen FloodNet event) | building now |
| AWS services for a community verification endpoint | planned, will only be claimed after they run |

## Data and provenance

- FloodNet street water-level events via NYC Open Data (dataset `aq7i-eu5q`),
  captured 2026-10-10; upstream dataset last updated 2026-10-01T13:00:21Z.
- NYC 311 is used for context only. A complaint is reported evidence, not sensor truth.
- NYC is the build city because it publishes machine-readable data of this kind.
  Delhi's PWD and civic bodies do not publish equivalent waterlogging or drain
  maintenance records; the request route there is an RTI with an about 30 day window.
  The ingestion design is city-agnostic so the same card can render for Delhi later.

## Rules this project keeps

- Missing data is shown as missing, never zero-filled.
- No prediction, no warnings, no real-time claims. This is a historical evidence card.
- Tidally influenced FloodNet sensors are separated from rainfall-only interpretation.
- Imagery is context only; ML is future work, not a hidden feature.
- AI coding tools were used during development and are disclosed in the submission writeup.

## License

Code MIT, see `LICENSE`. Public data remains under its original NYC Open Data terms.
