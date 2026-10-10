# PLUVIA local evidence card

This static page shows the selected FloodNet event snapshot. It reads no network data.

## Rebuild the card data

From the repository root, run:

```sh
python3 PLUVIA/demo/build_card_data.py
```

The standard-library script checks the frozen candidate, profile, and sensor snapshots against `data/nyc/MANIFEST.json`, then writes `PLUVIA/demo/card_data.json`. Events without a stored profile remain selectable and are shown with an unavailable profile state.

## Open the page

Open `PLUVIA/demo/index.html` directly in a browser. Select `PLUVIA/demo/card_data.json` when prompted. A file picker is used because browsers restrict JavaScript `fetch()` from `file://` pages. The page reads only the selected card JSON. It does not load raw snapshots or external map assets.

The map plots only the coordinates present in the FloodNet sensor snapshot. It does not show street geometry. Select an event from the list or a map marker, then use the replay controls to move through the recorded profile points.
