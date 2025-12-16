# Arlington, MA – Revenue Per Acre map

Static Mapbox GL JS page plus a Python script to compute revenue per acre from MassGIS parcels and Arlington assessor data.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install pandas pyproj shapely geopandas fiona
```

## Data inputs

- Parcels: `data/raw/L3_SHP_M010_Arlington/M010TaxPar_CY25_FY25.shp` (MassGIS Level 3)
- Assessor CSV: `data/raw/Parcels_with_Assessor_Info_-6226017240774701821.csv`
- Tax rate: Arlington single rate (dollars per $1,000 of assessed value) – supply at runtime.

## Compute revenue per acre

```bash
.venv/bin/python3 scripts/process_parcels.py \\
  --tax-rate <RATE_PER_1000> \\
  --output data/processed/parcels_revenue.geojson
```

The script also writes `data/processed/summary.csv`. If you re-run with the true tax rate, overwrite the GeoJSON so the map shows correct numbers.

## Configure Mapbox

Edit `config.js` and add your token:

```js
const CONFIG = {
  mapboxToken: "pk....",
  mapStyle: "mapbox://styles/mapbox/light-v11",
  dataUrl: "data/processed/parcels_revenue.geojson",
};
```

If you prefer to keep the token private, create `config.local.js`, put the same `CONFIG` object there, and include that script tag instead.

## Run locally

Any static server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Hosting

You can drop the repo on GitHub Pages/Netlify/S3. Ensure `data/processed/parcels_revenue.geojson` is deployed alongside `index.html`.
