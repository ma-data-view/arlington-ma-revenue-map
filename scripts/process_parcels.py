import argparse
from pathlib import Path

import geopandas as gpd
import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Join Arlington parcels to assessor data and compute revenue per acre."
    )
    parser.add_argument(
        "--parcels",
        default="data/raw/L3_SHP_M010_Arlington/M010TaxPar_CY25_FY25.shp",
        help="Path to the MassGIS parcel shapefile (.shp).",
    )
    parser.add_argument(
        "--assessor",
        default="data/raw/Parcels_with_Assessor_Info_-6226017240774701821.csv",
        help="Path to the assessor CSV export.",
    )
    parser.add_argument(
        "--tax-rate",
        type=float,
        required=True,
        help="Property tax rate in dollars per $1000 of assessed value (e.g., 11.17).",
    )
    parser.add_argument(
        "--output",
        default="data/processed/parcels_revenue.geojson",
        help="Output GeoJSON path.",
    )
    parser.add_argument(
        "--public-output",
        default="data/processed/parcels_public.geojson",
        help="Public (attribute-trimmed) GeoJSON path.",
    )
    parser.add_argument(
        "--summary",
        default="data/processed/summary.csv",
        help="Optional CSV summary output path.",
    )
    return parser.parse_args()


def clean_key(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip()


def compute_revenue_per_acre(args: argparse.Namespace) -> None:
    parcels_path = Path(args.parcels)
    assessor_path = Path(args.assessor)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    gdf = gpd.read_file(parcels_path)
    if gdf.crs is None:
        raise ValueError("Parcel layer has no CRS; expected EPSG:26986.")

    assessor = pd.read_csv(assessor_path)

    gdf["MAP_PAR_ID"] = clean_key(gdf["MAP_PAR_ID"])
    assessor["GIS Parcel ID"] = clean_key(assessor["GIS Parcel ID"])
    assessor["Assessor Parcel ID"] = clean_key(assessor["Assessor Parcel ID"])

    exempt_owner_prefixes = [
        "TOWN OF ARLINGTON",
        "COMMONWEALTH OF MASSACHUSETTS",
        "MASSACHUSETTS",
        "UNITED STATES",
        "U S A",
        "FEDERAL",
        "MBTA",
        "MWRA",
        "HOUSING AUTHORITY",
    ]
    water_keywords = {"RESERVOIR", "AQUEDUCT", "WATER DEPT", "MWRA", "DCR"}

    merged = gdf.merge(
        assessor,
        left_on="MAP_PAR_ID",
        right_on="GIS Parcel ID",
        how="left",
        suffixes=("", "_assessor"),
    )

    merged = merged.to_crs(epsg=26986)
    merged["acres"] = merged.geometry.area / 4046.8564224

    merged["total_value"] = pd.to_numeric(
        merged.get("Total Value", pd.NA), errors="coerce"
    )
    merged["assessed_acres"] = pd.to_numeric(
        merged.get("Assessed Acres", pd.NA), errors="coerce"
    )

    def is_exempt(row: pd.Series) -> bool:
        owner = str(row.get("Owners") or "").upper()
        lu_code = str(row.get("Landuse Code") or "").strip()
        if lu_code.startswith("9"):
            return True
        return any(owner.startswith(prefix) for prefix in exempt_owner_prefixes)

    def is_water(row: pd.Series) -> bool:
        owner_upper = str(row.get("Owners") or "").upper()
        lu_desc = str(row.get("Landuse Description") or "").upper()
        lu_code_raw = str(row.get("Landuse Code") or "").strip()
        lu_code = lu_code_raw.split(".")[0] if lu_code_raw else ""
        if lu_code in {"920", "925"}:
            return True
        if any(key in owner_upper for key in water_keywords):
            return True
        if any(key in lu_desc for key in water_keywords):
            return True
        return False

    merged["tax_exempt"] = merged.apply(is_exempt, axis=1)
    merged["is_water"] = merged.apply(is_water, axis=1)

    tax_rate_per_k = float(args.tax_rate)
    merged["est_annual_tax"] = merged["total_value"].fillna(0) * (
        tax_rate_per_k / 1000.0
    )

    merged["rev_per_acre"] = merged["est_annual_tax"] / merged["acres"].replace(
        {0: pd.NA}
    )

    merged["unit_count"] = 1

    def join_addresses(series: pd.Series) -> str | None:
        vals = [s.strip() for s in series.dropna() if str(s).strip()]
        if not vals:
            return None
        # preserve order, keep unique
        seen = {}
        for v in vals:
            seen.setdefault(v, True)
        return " | ".join(seen.keys())

    grouped_df = (
        merged.groupby("MAP_PAR_ID", as_index=False)
        .agg(
            {
                "geometry": "first",
                "LOC_ID": "first",
                "acres": "first",
                "assessed_acres": "first",
                "total_value": "sum",
                "Building Value": "sum",
                "Land Value": "sum",
                "est_annual_tax": "sum",
                "rev_per_acre": "mean",  # recomputed below
                "Full Address": join_addresses,
                "Owners": "first",
                "Zoning Code": "first",
                "Zoning Description": "first",
                "Landuse Code": "first",
                "Landuse Description": "first",
                "Valuation Fiscal Year": "first",
                "unit_count": "sum",
                "tax_exempt": "any",
                "is_water": "any",
            }
        )
        .copy()
    )

    grouped = gpd.GeoDataFrame(grouped_df, geometry="geometry", crs=gdf.crs)

    grouped["est_annual_tax"] = grouped["total_value"].fillna(0) * (tax_rate_per_k / 1000.0)
    grouped.loc[grouped["tax_exempt"], ["est_annual_tax", "rev_per_acre"]] = 0
    grouped["rev_per_acre"] = grouped["est_annual_tax"] / grouped["acres"].replace({0: pd.NA})

    grouped = grouped.to_crs(epsg=4326)
    grouped.to_file(output_path, driver="GeoJSON")

    summary_cols = [
        "MAP_PAR_ID",
        "Full Address",
        "total_value",
        "est_annual_tax",
        "rev_per_acre",
        "acres",
        "Landuse Description",
        "unit_count",
        "tax_exempt",
        "is_water",
    ]
    summary = grouped[[c for c in summary_cols if c in grouped.columns]]
    summary.to_csv(args.summary, index=False)

    # Write trimmed public GeoJSON with only non-sensitive fields used by the map UI.
    public_cols = [
        "MAP_PAR_ID",
        "Full Address",
        "Landuse Description",
        "acres",
        "unit_count",
        "total_value",
        "est_annual_tax",
        "rev_per_acre",
        "tax_exempt",
        "is_water",
        "geometry",
    ]
    public_gdf = grouped[[c for c in public_cols if c in grouped.columns]].copy()
    public_gdf.to_file(Path(args.public_output), driver="GeoJSON")


def main() -> None:
    args = parse_args()
    compute_revenue_per_acre(args)


if __name__ == "__main__":
    main()
