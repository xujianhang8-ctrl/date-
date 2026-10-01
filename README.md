# Thomson Reserve · 3D Explorer

An interactive 3D website for the Thomson Reserve condominium (1–11 Bright Hill Drive, Singapore).
Visitors can:

- orbit the six towers on the real 5-hectare site, with every one of the 1,268 homes coloured by bedroom type,
- filter by bedroom count, collection (Classic / Luxury) or unit type,
- pick a unit by block / level / stack or search for it (e.g. `#25-19`) to see its type, size, facing and floor plan,
- run a sun and shadow study for any date and time,
- switch on **Real city view** (Google Photorealistic 3D Tiles) and jump to the view from a unit's windows.

It is a static site: no build step and no server code.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css` | Page layout |
| `app.js` | 3D scene (CesiumJS), filters, unit picker, sun study, real-city view |
| `config.js` | Project name, Google Maps key, contact details |
| `data.js` | Generated: units, unit types, tower and stack footprints, site boundary, pools |
| `floorplans/` | Generated: one floor-plan image per brochure page |
| `tools/build_data.py` | Rebuilds `data.js` and `floorplans/` from the brochure PDF |

## Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Rebuild the data from the brochure

```sh
pip install pymupdf numpy opencv-python-headless pillow
python3 tools/build_data.py "Thomson_Reserve_Units_Mix_Site_Plan_and_Full_Floor_Plan.pdf"
```

The script reads the stack charts, the unit-type pages, the key plan (towers and stack outlines,
traced from the vector drawing) and the illustrated site plan (pools). The key plan is placed on
the map using its north arrow, a scale checked against the floor-plan scale bar and the 5-hectare
site area, and a position fitted to Upper Thomson Road and Bright Hill Drive on satellite imagery.

## Google Maps key

The real-city view needs a Google Maps Platform key with the **Map Tiles API** enabled, set in
`config.js`. Because the key is visible in the page source, restrict it in Google Cloud Console:

- **Application restrictions → Websites:** your site's address (e.g. `https://<user>.github.io/*`)
  and `http://localhost:8000/*` for testing.
- **API restrictions:** Map Tiles API only.

## Known limitations

- Building massing is indicative: footprints come from the key plan, but floor-to-floor heights
  (3.15 m) and the Classic towers' carpark storey are estimates.
- A unit's "facing" is the direction from the tower core to the stack, rounded to 8 compass points.
- WhatsApp buttons stay hidden until `whatsappNumber` is set in `config.js`.
