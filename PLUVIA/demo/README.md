# PLUVIA local evidence card

This is a single-event, static replay card. It reads no network data.

## Rebuild the card data

From the repository root, run:

```sh
python3 PLUVIA/demo/build_card_data.py
```

The standard-library script reads the frozen R1 candidate and FloodNet profile snapshots, checks that their event fields and profile arrays agree, and writes `PLUVIA/demo/card_data.json`.

## Open the page

Open `PLUVIA/demo/index.html` directly in a browser. Select `PLUVIA/demo/card_data.json` when prompted. A file picker is used because browsers restrict JavaScript `fetch()` from `file://` pages. The page reads only the selected card JSON; it does not load the raw snapshots.
