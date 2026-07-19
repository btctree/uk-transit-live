"""NaPTAN adapter — every public transport stop in Great Britain.

Free, keyless, OGL: https://beta-naptan.dft.gov.uk. The ~100MB national CSV is
downloaded once, reduced to the fields we need, cached on disk, and indexed
into a coarse lat/lon grid for fast viewport queries.
"""
import asyncio
import csv
import io
import json
from pathlib import Path

import httpx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
CSV_URL = "https://beta-naptan.dft.gov.uk/Download/National/csv"
# bus/coach stop points + tram/metro platforms & access points
STOP_TYPES = {"BCT", "BCS", "BCQ", "TMU", "PLT", "MET"}

_index: dict | None = None
_status = {"state": "idle", "count": 0}


def status() -> dict:
    return dict(_status)


def _cell(lat: float, lon: float) -> str:
    return f"{int(lat * 20)}:{int(lon * 20)}"


def _load_from_disk() -> bool:
    f = DATA_DIR / "stops_gb.json"
    if not f.exists():
        return False
    stops = json.loads(f.read_text(encoding="utf-8"))
    cells: dict[str, list[int]] = {}
    for i, s in enumerate(stops):
        cells.setdefault(_cell(s[3], s[4]), []).append(i)
    global _index
    _index = {"stops": stops, "cells": cells}
    _status.update(state="ready", count=len(stops))
    return True


def _parse_csv(text: str) -> list:
    stops = []
    rdr = csv.DictReader(io.StringIO(text))
    for row in rdr:
        if (row.get("Status") or "active").strip().lower() not in ("active", "act", ""):
            continue
        if (row.get("StopType") or "").strip() not in STOP_TYPES:
            continue
        try:
            lat = float(row["Latitude"])
            lon = float(row["Longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        stops.append([
            (row.get("ATCOCode") or "").strip(),
            (row.get("CommonName") or "").strip(),
            (row.get("Indicator") or "").strip(),
            round(lat, 5),
            round(lon, 5),
        ])
    return stops


async def ensure(client: httpx.AsyncClient) -> None:
    """Idempotent: load the disk cache, or download+build it once."""
    if _status["state"] in ("ready", "downloading"):
        return
    if _load_from_disk():
        return
    _status["state"] = "downloading"
    try:
        r = await client.get(CSV_URL, timeout=900, follow_redirects=True,
                             headers={"User-Agent": "uk-transit-live/0.1"})
        r.raise_for_status()
        text = r.content.decode("utf-8-sig", errors="replace")
        stops = await asyncio.to_thread(_parse_csv, text)  # CPU-heavy: off the loop
        (DATA_DIR / "stops_gb.json").write_text(json.dumps(stops), encoding="utf-8")
        _load_from_disk()
    except Exception:
        _status["state"] = "error"


def in_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float,
            limit: int = 400) -> list | None:
    """Stops inside a bbox (None while the index isn't ready)."""
    if _index is None:
        return None
    la0, la1 = int(min_lat * 20), int(max_lat * 20)
    lo0, lo1 = int(min_lon * 20), int(max_lon * 20)
    if (la1 - la0 + 1) * (lo1 - lo0 + 1) > 2500:
        return []  # viewport far too wide for stop display — zoom in
    out = []
    for la in range(la0, la1 + 1):
        for lo in range(lo0, lo1 + 1):
            for i in _index["cells"].get(f"{la}:{lo}", []):
                s = _index["stops"][i]
                if min_lat <= s[3] <= max_lat and min_lon <= s[4] <= max_lon:
                    out.append(s)
                    if len(out) >= limit:
                        return out
    return out


_by_id: dict[str, list] | None = None


def by_id(atco: str):
    """Look up one stop by ATCO code (None if index not ready / unknown)."""
    global _by_id
    if _index is None:
        return None
    if _by_id is None:
        _by_id = {s[0]: s for s in _index["stops"]}
    return _by_id.get(atco)
