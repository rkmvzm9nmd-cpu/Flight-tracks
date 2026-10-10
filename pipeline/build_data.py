"""Build the globe's data from eBird Status and Trends.

For each species in species.json this script:
  1. downloads the weekly relative-abundance raster (27 km, 52 weeks),
  2. re-projects it from Equal Earth (EPSG:8857) to a plain lat/lon grid,
  3. renders 52 transparent PNG frames for the globe,
  4. works out the weekly centre of each regional population (the "paths"),
  5. writes a manifest the website reads.

It needs an eBird Status and Trends access key in the EBIRDST_KEY
environment variable. Request one at https://ebird.org/st/request.

Usage:
    python pipeline/build_data.py                 # all species
    python pipeline/build_data.py --only barswa   # one species
    python pipeline/build_data.py --tif path.tif --code test   # local file, no download
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

API = "https://st-download.ebird.org/v1"
VERSION_YEAR = "2023"
OUT_W, OUT_H = 1440, 720  # 0.25 degree grid

# Longitude bands used to split a species into regional populations.
# A species can migrate within several of these at once (e.g. Barn Swallow).
REGIONS = [
    {"id": "americas", "name": "Americas", "lon": [(-170.0, -25.0)]},
    {"id": "eurafrica", "name": "Europe and Africa", "lon": [(-25.0, 60.0)]},
    {"id": "asiapac", "name": "Asia and the Pacific", "lon": [(60.0, 180.0), (-180.0, -170.0)]},
]
MIN_REGION_SHARE = 0.05   # a region must hold 5% of the year's birds to get a path
MIN_WEEK_FRACTION = 0.03  # skip weeks where a region holds under 3% of its peak

# Colour ramp for abundance, low to high: dusk violet, rose, gold, pale gold.
RAMP = [
    (0.00, (91, 75, 154)),
    (0.40, (196, 92, 145)),
    (0.70, (240, 150, 96)),
    (0.88, (246, 202, 98)),
    (1.00, (255, 244, 214)),
]


# --------------------------------------------------------------------------
# Equal Earth (EPSG:8857, WGS 84 ellipsoid) forward projection
# --------------------------------------------------------------------------
A_WGS84 = 6378137.0
E_WGS84 = 0.0818191908426215
EE_A1, EE_A2, EE_A3, EE_A4 = 1.340264, -0.081106, 0.000893, 0.003796


def _q(sinphi: np.ndarray, e: float) -> np.ndarray:
    es = e * sinphi
    return (1 - e * e) * (sinphi / (1 - es * es) - (1 / (2 * e)) * np.log((1 - es) / (1 + es)))


_QP = float(_q(np.array(1.0), E_WGS84))
R_AUTHALIC = A_WGS84 * math.sqrt(_QP / 2)


def equal_earth_forward(lon_deg: np.ndarray, lat_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Project lon/lat in degrees to Equal Earth metres (EPSG:8857)."""
    lam = np.radians(lon_deg)
    sinphi = np.sin(np.radians(lat_deg))
    beta = np.arcsin(np.clip(_q(sinphi, E_WGS84) / _QP, -1, 1))  # authalic latitude
    theta = np.arcsin(math.sqrt(3) / 2 * np.sin(beta))
    t2 = theta * theta
    t6 = t2 * t2 * t2
    x = R_AUTHALIC * 2 * math.sqrt(3) * lam * np.cos(theta) / (
        3 * (9 * EE_A4 * t6 * t2 + 7 * EE_A3 * t6 + 3 * EE_A2 * t2 + EE_A1)
    )
    y = R_AUTHALIC * theta * (EE_A4 * t6 * t2 + EE_A3 * t6 + EE_A2 * t2 + EE_A1)
    return x, y


# --------------------------------------------------------------------------
# Downloads
# --------------------------------------------------------------------------
def _get(url: str, retries: int = 4) -> bytes:
    import requests

    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=300)
            if r.status_code == 200:
                return r.content
            msg = f"HTTP {r.status_code}"
        except requests.RequestException as exc:  # network hiccup
            msg = str(exc)
        wait = 5 * (attempt + 1)
        print(f"    request failed ({msg}); retrying in {wait}s", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"Download failed after {retries} attempts: {url.split('key=')[0]}")


def fetch_species_files(code: str, key: str, cache: Path) -> tuple[Path, list[str], dict]:
    """Download (or reuse cached) weekly abundance raster, band dates and config."""
    d = cache / VERSION_YEAR / code
    d.mkdir(parents=True, exist_ok=True)
    listing = json.loads(_get(f"{API}/list-obj/{VERSION_YEAR}/{code}?key={key}"))
    wanted = {
        "tif": f"{VERSION_YEAR}/{code}/weekly/{code}_abundance_median_27km_{VERSION_YEAR}.tif",
        "dates": f"{VERSION_YEAR}/{code}/weekly/band-dates.csv",
        "config": f"{VERSION_YEAR}/{code}/config.json",
    }
    missing = [v for v in wanted.values() if v not in listing]
    if missing:
        raise RuntimeError(f"{code}: not available in eBird S&T {VERSION_YEAR} ({missing[0]})")
    paths = {}
    for kind, obj in wanted.items():
        p = d / Path(obj).name
        if not p.exists() or p.stat().st_size == 0:
            print(f"    downloading {Path(obj).name}", flush=True)
            p.write_bytes(_get(f"{API}/fetch?objKey={obj}&key={key}"))
        paths[kind] = p
    dates = read_band_dates(paths["dates"].read_text())
    config = json.loads(paths["config"].read_text())
    return paths["tif"], dates, config


def read_band_dates(text: str) -> list[str]:
    rows = list(csv.DictReader(io.StringIO(text)))
    rows.sort(key=lambda r: int(r["band"]))
    return [r["date"] for r in rows]


def default_dates() -> list[str]:
    start = dt.date(int(VERSION_YEAR), 1, 4)
    return [(start + dt.timedelta(weeks=i)).isoformat() for i in range(52)]


# --------------------------------------------------------------------------
# Raster reading and re-projection
# --------------------------------------------------------------------------
def read_weekly_raster(path: Path, config: dict | None) -> tuple[np.ndarray, dict]:
    """Return (weeks, rows, cols) float32 array with NaN for no data, plus grid info."""
    with tifffile.TiffFile(path) as tif:
        geo = tif.geotiff_metadata or {}
        page = tif.pages[0]
        nodata = None
        tag = page.tags.get("GDAL_NODATA")
        if tag is not None:
            try:
                nodata = float(str(tag.value).strip().strip("\x00"))
            except ValueError:
                nodata = None
        arr = tif.asarray()

    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 2:
        arr = arr[None]
    elif arr.ndim == 3 and arr.shape[-1] in (52, 53) and arr.shape[0] not in (52, 53):
        arr = np.moveaxis(arr, -1, 0)  # (rows, cols, bands) -> (bands, rows, cols)

    # Projection check: eBird S&T 2023 rasters are Equal Earth (EPSG:8857).
    epsg = geo.get("ProjectedCSTypeGeoKey")
    epsg = getattr(epsg, "value", epsg)
    crs_cfg = ""
    if config:
        crs_cfg = str(((config.get("projection") or {}).get("crs") or [""])[0]).lower()
    if epsg not in (8857, None) and crs_cfg != "epsg:8857":
        raise RuntimeError(f"Unexpected projection {epsg!r} in {path.name}; expected EPSG:8857")
    if epsg is None and crs_cfg not in ("epsg:8857", ""):
        raise RuntimeError(f"Unexpected projection {crs_cfg!r}; expected EPSG:8857")

    scale = geo.get("ModelPixelScale")
    tie = geo.get("ModelTiepoint")
    if not scale or not tie:
        raise RuntimeError(f"{path.name} has no georeferencing tags")
    sx, sy = float(scale[0]), float(scale[1])
    # Tiepoint maps raster (i, j) to model (x, y); normally (0, 0) -> top-left corner.
    i0, j0, x_tie, y_tie = float(tie[0]), float(tie[1]), float(tie[3]), float(tie[4])
    x0 = x_tie - i0 * sx
    y0 = y_tie + j0 * sy
    # GeoTIFFs written as PixelIsPoint put the tiepoint on the pixel centre.
    raster_type = geo.get("GTRasterTypeGeoKey")
    raster_type = getattr(raster_type, "value", raster_type)
    if raster_type == 2:
        x0 -= sx / 2
        y0 += sy / 2

    bad = ~np.isfinite(arr) | (arr < 0)
    if nodata is not None:
        bad |= arr == nodata
    arr[bad] = np.nan
    return arr, {"x0": x0, "y0": y0, "sx": sx, "sy": sy}


def build_lookup(grid: dict, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For every output lat/lon cell, find the source pixel it falls in."""
    rows, cols = shape
    lon = -180 + (np.arange(OUT_W) + 0.5) * (360 / OUT_W)
    lat = 90 - (np.arange(OUT_H) + 0.5) * (180 / OUT_H)
    lon2, lat2 = np.meshgrid(lon, lat)
    x, y = equal_earth_forward(lon2, lat2)
    c = np.floor((x - grid["x0"]) / grid["sx"]).astype(np.int64)
    r = np.floor((grid["y0"] - y) / grid["sy"]).astype(np.int64)
    inside = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
    return np.where(inside, r, 0), np.where(inside, c, 0), inside


def reproject(arr: np.ndarray, grid: dict) -> np.ndarray:
    r, c, inside = build_lookup(grid, arr.shape[1:])
    out = arr[:, r, c]
    out[:, ~inside] = np.nan
    return out


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------
def ramp_lut() -> np.ndarray:
    xs = np.linspace(0, 1, 256)
    stops = np.array([s[0] for s in RAMP])
    cols = np.array([s[1] for s in RAMP], dtype=float)
    return np.stack([np.interp(xs, stops, cols[:, k]) for k in range(3)], axis=1).astype(np.uint8)


def abundance_rank(ll: np.ndarray) -> np.ndarray:
    """Map abundance to 0..1 by its rank among the species' non-zero values.

    eBird's own maps bin abundance by quantiles per species; ranking does the
    same job and keeps both thinly spread and dense species readable.
    """
    pos = ll[np.isfinite(ll) & (ll > 0)]
    rank = np.full(ll.shape, np.nan, dtype=np.float32)
    if pos.size == 0:
        return rank
    qs = np.quantile(pos, np.linspace(0, 1, 201))
    qs = np.maximum.accumulate(qs)  # guard against ties
    m = np.isfinite(ll) & (ll > 0)
    rank[m] = np.interp(ll[m], qs, np.linspace(0, 1, 201))
    return rank


def render_frames(rank: np.ndarray, out_dir: Path) -> list[int]:
    lut = ramp_lut()
    sizes = []
    for w in range(rank.shape[0]):
        v = rank[w]
        present = np.isfinite(v)
        idx = np.zeros(v.shape, dtype=np.uint8)
        idx[present] = np.clip(v[present] * 255, 0, 255).astype(np.uint8)
        rgba = np.zeros(v.shape + (4,), dtype=np.uint8)
        rgba[..., :3] = lut[idx]
        alpha = np.where(present, 110 + 135 * np.clip(v, 0, 1), 0)
        rgba[..., 3] = np.nan_to_num(alpha).astype(np.uint8)
        img = Image.fromarray(rgba, "RGBA").quantize(colors=96, method=Image.Quantize.FASTOCTREE)
        p = out_dir / f"w{w:02d}.png"
        img.save(p, optimize=True)
        sizes.append(p.stat().st_size)
    return sizes


# --------------------------------------------------------------------------
# Regional population paths
# --------------------------------------------------------------------------
def region_mask(lon: np.ndarray, region: dict) -> np.ndarray:
    m = np.zeros(lon.shape, dtype=bool)
    for lo, hi in region["lon"]:
        m |= (lon >= lo) & (lon < hi)
    return m


def compute_paths(ll: np.ndarray, dates: list[str]) -> list[dict]:
    lon = -180 + (np.arange(OUT_W) + 0.5) * (360 / OUT_W)
    lat = 90 - (np.arange(OUT_H) + 0.5) * (180 / OUT_H)
    lon2, lat2 = np.meshgrid(lon, lat)
    area = np.cos(np.radians(lat2))  # relative cell area on a lat/lon grid
    weights = np.nan_to_num(ll) * area  # (weeks, H, W)

    # Unit vectors for an averaging that behaves across the date line.
    lr, pr = np.radians(lon2), np.radians(lat2)
    ux, uy, uz = np.cos(pr) * np.cos(lr), np.cos(pr) * np.sin(lr), np.sin(pr)

    totals_all = weights.sum(axis=(1, 2)).sum()
    paths = []
    if totals_all <= 0:
        return paths
    for region in REGIONS:
        m = region_mask(lon2, region)
        wr = weights * m
        tot = wr.sum(axis=(1, 2))
        share = float(tot.sum() / totals_all)
        if share < MIN_REGION_SHARE:
            continue
        peak = float(tot.max())
        points = []
        for w in range(wr.shape[0]):
            if tot[w] < MIN_WEEK_FRACTION * peak:
                points.append(None)
                continue
            vx = float((wr[w] * ux).sum())
            vy = float((wr[w] * uy).sum())
            vz = float((wr[w] * uz).sum())
            norm = math.sqrt(vx * vx + vy * vy + vz * vz) or 1.0
            plat = math.degrees(math.asin(vz / norm))
            plon = math.degrees(math.atan2(vy, vx))
            points.append([round(plat, 2), round(plon, 2)])
        paths.append(
            {
                "region": region["id"],
                "name": region["name"],
                "share": round(share, 3),
                "points": points,
                # Relative number of birds in the region each week (0..1), for the timeline.
                "presence": [round(float(t / peak), 3) if peak > 0 else 0 for t in tot],
            }
        )
    paths.sort(key=lambda p: -p["share"])
    return paths


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def process(code: str, tif_path: Path, dates: list[str], config: dict | None, out_root: Path) -> dict:
    t0 = time.time()
    arr, grid = read_weekly_raster(tif_path, config)
    if arr.shape[0] != len(dates):
        print(f"    note: {arr.shape[0]} bands but {len(dates)} dates; using band count")
        dates = (dates + default_dates())[: arr.shape[0]]
    ll = reproject(arr, grid)
    del arr
    rank = abundance_rank(ll)
    out_dir = out_root / "species" / code
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = render_frames(rank, out_dir)
    paths = compute_paths(ll, dates)
    (out_dir / "paths.json").write_text(json.dumps({"code": code, "paths": paths}, separators=(",", ":")))
    print(
        f"    {len(sizes)} frames, {sum(sizes) / 1e6:.1f} MB, "
        f"{len(paths)} regional path(s), {time.time() - t0:.0f}s",
        flush=True,
    )
    return {"frames": len(sizes), "dates": dates, "regions": [p["region"] for p in paths]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root = Path(__file__).resolve().parent.parent
    ap.add_argument("--species", type=Path, default=root / "pipeline" / "species.json")
    ap.add_argument("--out", type=Path, default=root / "site" / "data")
    ap.add_argument("--cache", type=Path, default=root / ".cache")
    ap.add_argument("--only", nargs="*", help="species codes to build (default: all)")
    ap.add_argument("--tif", type=Path, help="process a local raster instead of downloading")
    ap.add_argument("--code", help="species code to use with --tif")
    args = ap.parse_args()

    species = json.loads(args.species.read_text())
    by_code = {s["code"]: s for s in species}
    args.out.mkdir(parents=True, exist_ok=True)

    manifest_path = args.out / "manifest.json"
    previous = {}
    if manifest_path.exists():
        previous = {s["code"]: s for s in json.loads(manifest_path.read_text()).get("species", [])}

    built: dict[str, dict] = {}
    failures: list[str] = []
    week_dates = default_dates()

    if args.tif:
        code = args.code or args.tif.stem
        print(f"{code}: local file {args.tif}")
        info = process(code, args.tif, default_dates(), None, args.out)
        built[code] = info
    else:
        key = os.environ.get("EBIRDST_KEY", "").strip()
        if not key:
            print("EBIRDST_KEY is not set. Request a key at https://ebird.org/st/request.", file=sys.stderr)
            return 2
        todo = args.only or [s["code"] for s in species]
        for code in todo:
            print(f"{code}: {by_code.get(code, {}).get('common', '?')}", flush=True)
            try:
                tif, dates, config = fetch_species_files(code, key, args.cache)
                built[code] = process(code, tif, dates, config, args.out)
                week_dates = built[code]["dates"]
            except Exception as exc:  # keep going; one bad species shouldn't sink the site
                print(f"    skipped: {exc}", file=sys.stderr, flush=True)
                failures.append(code)

    entries = []
    for s in species:
        code = s["code"]
        info = built.get(code) or previous.get(code)
        if not info:
            continue
        entries.append(
            {
                "code": code,
                "common": s.get("common", code),
                "sci": s.get("sci", ""),
                "blurb": s.get("blurb", ""),
                "frames": info["frames"],
                "regions": info.get("regions", []),
            }
        )
    for code, info in built.items():
        if code not in by_code:
            entries.append({"code": code, "common": code, "sci": "", "blurb": "", "frames": info["frames"],
                            "regions": info.get("regions", [])})

    manifest = {
        "source": "eBird Status and Trends",
        "version_year": VERSION_YEAR,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "grid": {"width": OUT_W, "height": OUT_H},
        "weeks": week_dates,
        "species": entries,
    }
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"Wrote {len(entries)} species to {manifest_path}")
    if failures:
        print(f"Skipped: {', '.join(failures)}", file=sys.stderr)
    return 1 if failures and not entries else 0


if __name__ == "__main__":
    sys.exit(main())
