#!/usr/bin/env python3
"""Build the local PLUVIA event selector payload from frozen NYC snapshots."""

import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEMO = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "data/nyc/MANIFEST.json"
CANDIDATES_PATH = ROOT / "data/nyc/selected/replay_candidates_2026-10-10.json"
PROFILES_PATH = ROOT / "data/nyc/raw/floodnet_replay_profiles_2026-10-10.json"
SENSORS_PATH = ROOT / "data/nyc/raw/floodnet_sensors_2026-10-10.json"
NETWORK_GLOB = "floodnet_network_*.json"
HISTORY_GLOB = "floodnet_events_full_*.json"
HISTORY_FALLBACK = "floodnet_events_2026_0101plus.json"
RAIN_GLOB = "nyc_daily_rain_*.json"
DRAINAGE_RAW_GLOB = "drainage_311_*.json"
DRAINAGE_DERIVED_GLOB = "drainage_near_sensors_*.json"
DRAINAGE_RADIUS_M = 300
RAIN_THRESHOLDS_MM = [1, 2, 5, 10, 15, 20, 30, 40, 60]
OUTPUT_PATH = DEMO / "card_data.json"
DEFAULT_EVENT_ID = "R1-primary"


def _haversine_m(lat_a, lon_a, lat_b, lon_b):
    radius = 6371000.0
    d_lat = math.radians(lat_b - lat_a)
    d_lon = math.radians(lon_b - lon_a)
    h = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat_a)) * math.cos(math.radians(lat_b)) * math.sin(d_lon / 2) ** 2)
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def load_drainage(network):
    """311 drainage complaints joined to the nearest sensors.

    Reads the large raw export when it is present and writes a small derived
    file next to it, so only the small file needs to live in the repository.
    """
    raw_dir = ROOT / "data/nyc/raw"
    derived_dir = ROOT / "data/nyc/derived"
    raw_matches = sorted(raw_dir.glob(DRAINAGE_RAW_GLOB))
    derived_matches = sorted(derived_dir.glob(DRAINAGE_DERIVED_GLOB))

    if not raw_matches:
        if not derived_matches:
            return None
        payload = read_json(derived_matches[-1])
        payload["file"] = derived_matches[-1].relative_to(ROOT).as_posix()
        return payload

    if not network:
        raise ValueError("The sensor network snapshot is needed to join drainage complaints")

    path = raw_matches[-1]
    rows = read_json(path)
    if isinstance(rows, dict):
        rows = rows.get("rows") or rows.get("data") or []

    cell = 0.01
    grid = {}
    buckets = {}
    for item in network["sensors"]:
        sensor_id = item["sensorId"]
        s_lat = float(item["latitude"])
        s_lon = float(item["longitude"])
        buckets[sensor_id] = []
        grid.setdefault((int(s_lat / cell), int(s_lon / cell)), []).append((sensor_id, s_lat, s_lon))

    used = 0
    skipped = 0
    descriptors = {}
    for row in rows:
        try:
            latitude = float(row.get("latitude"))
            longitude = float(row.get("longitude"))
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not (math.isfinite(latitude) and math.isfinite(longitude)):
            skipped += 1
            continue
        nearest_id = None
        nearest_m = None
        base_row = int(latitude / cell)
        base_col = int(longitude / cell)
        for d_row in (-1, 0, 1):
            for d_col in (-1, 0, 1):
                for sensor_id, s_lat, s_lon in grid.get((base_row + d_row, base_col + d_col), ()):
                    metres = _haversine_m(latitude, longitude, s_lat, s_lon)
                    if nearest_m is None or metres < nearest_m:
                        nearest_id, nearest_m = sensor_id, metres
        if nearest_id is None or nearest_m > DRAINAGE_RADIUS_M:
            skipped += 1
            continue
        used += 1
        descriptor = (row.get("descriptor") or "").strip() or "[UNKNOWN]"
        descriptors[descriptor] = descriptors.get(descriptor, 0) + 1
        buckets[nearest_id].append({
            "key": row.get("unique_key"),
            "created": str(row.get("created_date") or "")[:10] or None,
            "closed": str(row.get("closed_date") or "")[:10] or None,
            "descriptor": descriptor,
            "status": row.get("status"),
            "metres": round(nearest_m),
        })

    def days_between(first, second):
        try:
            from datetime import date
            a = date(*(int(part) for part in first.split("-")))
            b = date(*(int(part) for part in second.split("-")))
            return (b - a).days
        except Exception:
            return None

    by_sensor = []
    for sensor_id, items in buckets.items():
        if not items:
            continue
        items.sort(key=lambda item: item["created"] or "", reverse=True)
        closures = [
            days_between(item["created"], item["closed"])
            for item in items if item["created"] and item["closed"]
        ]
        closures = [value for value in closures if value is not None and value >= 0]
        closures.sort()
        median_close = None
        if closures:
            middle = len(closures) // 2
            median_close = closures[middle] if len(closures) % 2 else round((closures[middle - 1] + closures[middle]) / 2, 1)
        closed_dates = sorted(item["closed"] for item in items if item["closed"])
        by_sensor.append({
            "sensorId": sensor_id,
            "complaintCount": len(items),
            "closedCount": len(closures),
            "medianDaysToClose": median_close,
            "lastClosedDate": closed_dates[-1] if closed_dates else None,
            "lastComplaintDate": items[0]["created"],
            "records": items[:8],
        })
    by_sensor.sort(key=lambda item: -item["complaintCount"])

    payload = {
        "file": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "datasetId": "erm2-nwe9",
        "url": "https://data.cityofnewyork.us/resource/erm2-nwe9.json",
        "radiusMetres": DRAINAGE_RADIUS_M,
        "rowsRead": len(rows),
        "rowsMatched": used,
        "rowsOutsideRadius": skipped,
        "sensorsWithComplaints": len(by_sensor),
        "topDescriptors": sorted(descriptors.items(), key=lambda item: -item[1])[:6],
        "bySensor": by_sensor,
    }
    derived_dir.mkdir(parents=True, exist_ok=True)
    stamp = path.stem.split("_")[-1]
    out = derived_dir / f"drainage_near_sensors_{stamp}.json"
    with out.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, separators=(",", ":"))
        stream.write("\n")
    payload["derivedFile"] = out.relative_to(ROOT).as_posix()
    return payload


def _safe_number(value):
    try:
        number_value = float(value)
    except (TypeError, ValueError):
        return None
    return round(number_value, 1) if math.isfinite(number_value) else None


def load_rain():
    """Daily rainfall for the city, used to say what the weather actually did."""
    matches = sorted((ROOT / "data/nyc/raw").glob(RAIN_GLOB))
    if not matches:
        return None
    path = matches[-1]
    payload = read_json(path)
    daily = payload.get("daily") or {}
    times = daily.get("time") or []
    sums = daily.get("precipitation_sum") or []
    hours = daily.get("precipitation_hours") or []
    if not times or len(times) != len(sums):
        raise ValueError(f"{path.name} daily arrays do not line up")

    by_date = {}
    for index, day in enumerate(times):
        try:
            millimetres = float(sums[index])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(millimetres):
            continue
        try:
            rain_hours = float(hours[index])
        except (TypeError, ValueError, IndexError):
            rain_hours = None
        by_date[day] = {
            "mm": round(millimetres, 2),
            "hours": round(rain_hours, 1) if rain_hours is not None and math.isfinite(rain_hours) else None,
        }

    days_at_or_above = {
        str(threshold): sum(1 for row in by_date.values() if row["mm"] >= threshold)
        for threshold in RAIN_THRESHOLDS_MM
    }
    return {
        "file": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "source": "Open-Meteo historical reanalysis archive",
        "url": "https://archive-api.open-meteo.com/v1/archive",
        "point": {"latitude": payload.get("latitude"), "longitude": payload.get("longitude")},
        "timezone": payload.get("timezone"),
        "units": payload.get("daily_units"),
        "firstDay": times[0],
        "lastDay": times[-1],
        "dayCount": len(by_date),
        "thresholdsMm": RAIN_THRESHOLDS_MM,
        "daysAtOrAbove": days_at_or_above,
        "scopeNote": "one citywide daily series for the whole of New York City, not a per-street rain gauge",
        "_byDate": by_date,
    }


def load_history(rain=None, installed=None):
    """Per-sensor recorded flood history, used to mark hotspots on the map."""
    raw_dir = ROOT / "data/nyc/raw"
    matches = sorted(raw_dir.glob(HISTORY_GLOB))
    if matches:
        path = matches[-1]
        coverage = "every FloodNet flood event in the captured query window"
    else:
        path = raw_dir / HISTORY_FALLBACK
        coverage = "the sampled rows carried in this repository, not the full year"
    if not path.exists():
        return None

    payload = read_json(path)
    rows = payload.get("rows", []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError(f"{path.name} must hold an array of flood event rows")

    installed = installed or {}
    by_sensor = {}
    counted = 0
    earliest = None
    latest = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        sensor_id = row.get("sensor_id")
        start = row.get("flood_start_time")
        if not sensor_id or not start:
            continue
        try:
            depth = float(row.get("max_depth_inches"))
        except (TypeError, ValueError):
            depth = None
        if depth is not None and not math.isfinite(depth):
            depth = None
        counted += 1
        earliest = start if earliest is None or start < earliest else earliest
        latest = start if latest is None or start > latest else latest
        entry = by_sensor.setdefault(sensor_id, {
            "sensorId": sensor_id,
            "sensorName": row.get("sensor_name"),
            "floodCount": 0,
            "maxDepthIn": None,
            "lastFloodUtc": None,
            "lastFloodEndUtc": None,
            "lastDrainMin": None,
            "_onsets": [],
            "_drains": [],
            "_durations": [],
            "_depths": [],
            "_days": set(),
            "_rainDays": {},
            "_rainMm": [],
            "_rainHours": [],
            "_records": [],
        })
        entry["floodCount"] += 1
        day = str(start)[:10]
        rain_row = rain["_byDate"].get(day) if rain else None
        entry["_days"].add(day)
        if rain_row is not None:
            entry["_rainDays"][day] = rain_row
            entry["_rainMm"].append(rain_row["mm"])
            if rain_row["hours"] is not None:
                entry["_rainHours"].append(rain_row["hours"])
        entry["_records"].append({
            "date": day,
            "startUtc": utc_iso(start),
            "maxDepthIn": round(depth, 2) if depth is not None else None,
            "durationMin": _safe_number(row.get("duration_mins")),
            "onsetMin": _safe_number(row.get("onset_time_mins")),
            "drainMin": _safe_number(row.get("drain_time_mins")),
            "rainMm": rain_row["mm"] if rain_row else None,
            "rainHours": rain_row["hours"] if rain_row else None,
        })
        if depth is not None:
            entry["_depths"].append(depth)
            if entry["maxDepthIn"] is None or depth > entry["maxDepthIn"]:
                entry["maxDepthIn"] = round(depth, 2)
        for field, bucket in (("onset_time_mins", "_onsets"), ("drain_time_mins", "_drains"), ("duration_mins", "_durations")):
            try:
                value = float(row.get(field))
            except (TypeError, ValueError):
                continue
            if math.isfinite(value) and value >= 0:
                entry[bucket].append(value)
        if entry["lastFloodUtc"] is None or start > entry["lastFloodUtc"]:
            entry["lastFloodUtc"] = utc_iso(start)
            end = row.get("flood_end_time")
            entry["lastFloodEndUtc"] = utc_iso(end) if end else None
            try:
                entry["lastDrainMin"] = round(float(row.get("drain_time_mins")), 1)
            except (TypeError, ValueError):
                entry["lastDrainMin"] = None

    def median(values):
        if not values:
            return None
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return round(ordered[middle], 1)
        return round((ordered[middle - 1] + ordered[middle]) / 2, 1)

    for entry in by_sensor.values():
        entry["medianOnsetMin"] = median(entry.pop("_onsets"))
        entry["medianDrainMin"] = median(entry.pop("_drains"))
        entry["medianDurationMin"] = median(entry.pop("_durations"))
        depths = entry.pop("_depths")
        entry["medianDepthIn"] = median(depths)
        entry["eventsAbove4In"] = sum(1 for value in depths if value >= 4)

        days = entry.pop("_days")
        rain_days = entry.pop("_rainDays")
        rain_mm = entry.pop("_rainMm")
        rain_hours = entry.pop("_rainHours")
        records = entry.pop("_records")
        entry["floodDays"] = len(days)
        entry["rainDaysMatched"] = len(rain_days)
        entry["medianRainMm"] = median(rain_mm)
        entry["minRainMm"] = round(min(rain_mm), 2) if rain_mm else None
        entry["maxRainMm"] = round(max(rain_mm), 2) if rain_mm else None
        entry["medianRainHours"] = median(rain_hours)
        entry["floodDaysAtOrAbove"] = {
            str(threshold): sum(1 for row in rain_days.values() if row["mm"] >= threshold)
            for threshold in RAIN_THRESHOLDS_MM
        } if rain_days else None
        records.sort(key=lambda item: item["startUtc"], reverse=True)
        entry["records"] = records[:12]

        install_date = installed.get(entry["sensorId"])
        entry["installedDate"] = install_date
        if rain:
            eligible = {
                day: row for day, row in rain["_byDate"].items()
                if not install_date or day >= install_date
            }
            entry["eligibleDays"] = len(eligible)
            entry["eligibleFrom"] = install_date or rain["firstDay"]
            entry["eligibleBasis"] = "days after this sensor was installed" if install_date else "the whole rainfall archive, because the install date is unknown"
            entry["cityDaysAtOrAbove"] = {
                str(threshold): sum(1 for row in eligible.values() if row["mm"] >= threshold)
                for threshold in RAIN_THRESHOLDS_MM
            }
        else:
            entry["eligibleDays"] = None
            entry["eligibleFrom"] = None
            entry["eligibleBasis"] = None
            entry["cityDaysAtOrAbove"] = None

    return {
        "file": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "datasetId": "aq7i-eu5q",
        "url": "https://data.cityofnewyork.us/resource/aq7i-eu5q.json",
        "coverageNote": (
            f"{coverage}, {earliest[:10]} to {latest[:10]}" if earliest and latest else coverage
        ),
        "eventRows": counted,
        "sensorsWithFloods": len(by_sensor),
        "windowStartUtc": utc_iso(earliest) if earliest else None,
        "windowEndUtc": utc_iso(latest) if latest else None,
        "rainfallMeasurements": None,
        "communityReports": None,
        "bySensor": sorted(by_sensor.values(), key=lambda item: (-item["floodCount"], item["sensorId"])),
    }


def load_network():
    """Optional full FloodNet deployment snapshot, used to draw the whole network."""
    matches = sorted((ROOT / "data/nyc/raw").glob(NETWORK_GLOB))
    if not matches:
        return None
    path = matches[-1]
    rows = read_json(path)
    if isinstance(rows, dict):
        rows = rows.get("rows") or rows.get("data") or []
    if not isinstance(rows, list):
        raise ValueError(f"{path.name} must hold an array of sensor rows")

    sensors = []
    install_dates = {}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        sensor_id = row.get("sensor_id") or row.get("sensorId")
        latitude = row.get("latitude")
        longitude = row.get("longitude")
        if not sensor_id or latitude in (None, "") or longitude in (None, ""):
            continue
        try:
            latitude = float(latitude)
            longitude = float(longitude)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(latitude) and math.isfinite(longitude)):
            continue
        if not (40.40 <= latitude <= 41.00 and -74.40 <= longitude <= -73.60):
            continue
        if sensor_id in seen:
            continue
        seen.add(sensor_id)
        install = row.get("date_installed")
        install_dates[sensor_id] = str(install)[:10] if install else None
        sensors.append({
            "sensorId": sensor_id,
            "sensorName": row.get("sensor_name") or sensor_id,
            "borough": row.get("borough"),
            "zipcode": row.get("zipcode"),
            "streetName": row.get("street_name"),
            "neighborhood": row.get("nta"),
            "latitude": round(latitude, 6),
            "longitude": round(longitude, 6),
            "tidallyInfluenced": row.get("tidally_influenced"),
        })
    sensors.sort(key=lambda item: item["sensorId"])
    return {
        "file": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "datasetId": "kb2e-tjy3",
        "url": "https://data.cityofnewyork.us/resource/kb2e-tjy3.json",
        "count": len(sensors),
        "rawInstallDates": install_dates,
        "sensors": sensors,
    }


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite snapshot number")
    return value


def as_array(value, name):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def utc_iso(value):
    return value if value.endswith("Z") else value + "Z"


def verify_manifest(manifest):
    files = {item["path"]: item for item in manifest["files"]}
    inputs = (CANDIDATES_PATH, PROFILES_PATH, SENSORS_PATH)
    for path in inputs:
        relative = path.relative_to(ROOT).as_posix()
        expected = files[relative]["sha256"]
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"Snapshot hash mismatch: {relative}")
    return files


def make_profile(row, candidate):
    depths = as_array(row["flood_profile_depth_inches"], "profile depths")
    times = as_array(row["flood_profile_time_secs"], "profile times")
    if len(depths) != len(times):
        raise ValueError(f"Profile array lengths differ for {candidate['rank']}")

    points = []
    observed_depths = []
    previous_time = None
    for index, (seconds, depth) in enumerate(zip(times, depths)):
        seconds = number(seconds, f"profile time {index}")
        if previous_time is not None and seconds <= previous_time:
            raise ValueError(f"Profile time is not increasing for {candidate['rank']}")
        previous_time = seconds
        if depth is None:
            points.append({"elapsedSeconds": seconds, "depthInches": None})
            continue
        depth = number(depth, f"profile depth {index}")
        if depth < 0:
            raise ValueError(f"Negative depth in {candidate['rank']}")
        observed_depths.append(depth)
        points.append({"elapsedSeconds": seconds, "depthInches": depth})

    if not points or not observed_depths:
        raise ValueError(f"No measured profile values for {candidate['rank']}")
    maximum = number(candidate["max_depth_inches"], "max_depth_inches")
    if not math.isclose(max(observed_depths), maximum, abs_tol=0.01):
        raise ValueError(f"Profile maximum does not match {candidate['rank']}")
    duration = number(candidate["duration_mins"], "duration_mins")
    if not math.isclose(points[-1]["elapsedSeconds"] / 60, duration, abs_tol=0.01):
        raise ValueError(f"Profile endpoint does not match {candidate['rank']} duration")
    return points


def build_event(candidate, profile_rows, sensor_rows):
    sensor_id = candidate["sensor_id"]
    start = candidate["event_start_utc"]
    matching = [
        row for row in profile_rows
        if row.get("sensor_id") == sensor_id and row.get("flood_start_time") == start
    ]
    if len(matching) > 1:
        raise ValueError(f"Duplicate profile rows for {candidate['rank']}")
    profile_row = matching[0] if matching else None
    sensor = sensor_rows.get(sensor_id)

    if sensor and sensor.get("sensor_name") != candidate.get("sensor_name"):
        raise ValueError(f"Sensor metadata name mismatch for {candidate['rank']}")
    if candidate.get("tidally_influenced") != "No":
        raise ValueError(f"Unexpected tidal sensor in rainfall replay: {candidate['rank']}")

    profile = None
    profile_status = "unavailable"
    if profile_row:
        for candidate_field, profile_field in (
            ("sensor_name", "sensor_name"),
            ("event_end_utc", "flood_end_time"),
            ("max_depth_inches", "max_depth_inches"),
            ("duration_mins", "duration_mins"),
            ("evidence_label", "evidence_label"),
        ):
            if candidate.get(candidate_field) != profile_row.get(profile_field):
                raise ValueError(f"Candidate/profile mismatch for {candidate_field}")
        profile = make_profile(profile_row, candidate)
        profile_status = "available"

    latitude = sensor.get("latitude") if sensor else None
    longitude = sensor.get("longitude") if sensor else None
    if latitude is not None:
        latitude = number(latitude, f"{candidate['rank']} latitude")
    if longitude is not None:
        longitude = number(longitude, f"{candidate['rank']} longitude")

    return {
        "eventId": candidate["rank"],
        "rank": candidate["rank"],
        "sensorId": sensor_id,
        "sensorName": candidate["sensor_name"],
        "startUtc": utc_iso(start),
        "endUtc": utc_iso(candidate["event_end_utc"]),
        "maxDepthIn": number(candidate["max_depth_inches"], "max_depth_inches"),
        "durationMin": number(candidate["duration_mins"], "duration_mins"),
        "onsetMin": number(candidate["onset_time_mins"], "onset_time_mins"),
        "drainMin": number(candidate["drain_time_mins"], "drain_time_mins"),
        "durationAbove4InMin": number(candidate["duration_above_4_inches_mins"], "duration_above_4_inches_mins"),
        "durationAbove12InMin": number(candidate["duration_above_12_inches_mins"], "duration_above_12_inches_mins"),
        "durationAbove24InMin": number(candidate["duration_above_24_inches_mins"], "duration_above_24_inches_mins"),
        "tidalInfluence": candidate["tidally_influenced"],
        "evidenceLabel": candidate["evidence_label"],
        "profileStatus": profile_status,
        "profile": profile,
        "historyNote": candidate.get("history_note"),
        "location": {
            "latitude": latitude,
            "longitude": longitude,
            "borough": sensor.get("borough") if sensor else None,
            "communityBoard": sensor.get("community_board") if sensor else None,
            "zipcode": sensor.get("zipcode") if sensor else None,
        },
    }


def build_card_data():
    manifest = read_json(MANIFEST_PATH)
    candidates = read_json(CANDIDATES_PATH)
    profiles = read_json(PROFILES_PATH)
    sensors = read_json(SENSORS_PATH)
    manifest_files = verify_manifest(manifest)

    profile_meta = profiles["meta"]
    sensor_meta = sensors["meta"]
    if not (
        candidates["meta"]["generated_at"]
        == profile_meta["generated_at"]
        == sensor_meta["generated_at"]
        == manifest["generated_at"]
    ):
        raise ValueError("Snapshot capture timestamps do not match")

    sensor_rows = {row["sensor_id"]: row for row in sensors["selected_sensor_rows"]}
    events = [
        build_event(row, profiles["rows"], sensor_rows)
        for row in candidates["selected"]
    ]
    if not events or events[0]["eventId"] != DEFAULT_EVENT_ID:
        raise ValueError("Expected the canonical R1 event first in the snapshot")

    sensor_manifest = manifest_files[SENSORS_PATH.relative_to(ROOT).as_posix()]
    sensor_updated_at = sensor_manifest["dataset_rows_updated_at"].split()[0]
    network = load_network()
    rain = load_rain()
    installed = {}
    if network:
        for row in network.get("rawInstallDates", {}).items():
            installed[row[0]] = row[1]
    history = load_history(rain, installed)
    drainage = load_drainage(network)
    if rain:
        rain.pop("_byDate", None)
    return {
        "defaultEventId": DEFAULT_EVENT_ID,
        "events": events,
        "network": network,
        "history": history,
        "rain": rain,
        "drainage": drainage,
        "provenance": {
            "dataset": "FloodNet NYC via NYC Open Data",
            "datasetId": "aq7i-eu5q",
            "url": profile_meta["source_url"],
            "snapshotAsOf": profile_meta["generated_at"],
            "updatedAt": profile_meta["dataset_rows_updated_at"],
        },
        "mapProvenance": {
            "dataset": "FloodNet sensor deployment metadata via NYC Open Data",
            "datasetId": "kb2e-tjy3",
            "url": sensor_meta["source_url"],
            "snapshotAsOf": sensor_meta["generated_at"],
            "updatedAt": sensor_updated_at,
        },
        "context": {
            "weather": {
                "label": "unavailable",
                "evidenceType": "forecast",
                "reason": "No frozen weather snapshot is included in this replay package.",
            },
            "reports": {
                "label": "unavailable",
                "evidenceType": "reported",
                "reason": "No location-level 311 or community rows are included in this replay package.",
            },
            "inference": {
                "label": "inferred",
                "status": "not_used",
                "reason": "No present-condition or passability inference is made.",
            },
            "refusalNote": "This view shows selected historical FloodNet sensor records only. It does not establish present road passability or drainage condition, and it does not describe locations without a selected sensor record.",
        },
    }


def main():
    card = build_card_data()
    with OUTPUT_PATH.open("w", encoding="utf-8") as stream:
        json.dump(card, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    available = sum(event["profileStatus"] == "available" for event in card["events"])
    located = sum(
        event["location"]["latitude"] is not None
        and event["location"]["longitude"] is not None
        for event in card["events"]
    )
    primary = card["events"][0]
    print(f"Wrote {OUTPUT_PATH.relative_to(ROOT)}")
    print(f"Selected snapshot events: {len(card['events'])}; profiles available: {available}; coordinate points: {located}")
    print(
        f"Default: {primary['sensorName']} | max {primary['maxDepthIn']:.2f} in | "
        f"duration {primary['durationMin']:.2f} min | profile points {len(primary['profile'])}"
    )
    drainage = card.get("drainage")
    if drainage:
        print(
            f"Drainage layer: {drainage['rowsMatched']} of {drainage['rowsRead']} 311 rows fell within "
            f"{drainage['radiusMetres']} m of a sensor, covering {drainage['sensorsWithComplaints']} sensors"
        )
        if drainage.get("derivedFile"):
            print(f"  wrote {drainage['derivedFile']}")
    else:
        print("Drainage layer: not present.")
    rain = card.get("rain")
    if rain:
        print(
            f"Rainfall layer: {rain['dayCount']} daily records {rain['firstDay']} to {rain['lastDay']} "
            f"from {rain['file']} ({rain['source']})"
        )
    else:
        print("Rainfall layer: not present.")
    history = card.get("history")
    if history:
        print(
            f"Flood history layer: {history['eventRows']} recorded events across "
            f"{history['sensorsWithFloods']} sensors from {history['file']} "
            f"({history['coverageNote']})"
        )
    else:
        print("Flood history layer: not present.")
    network = card.get("network")
    if network:
        print(
            f"Sensor network layer: {network['count']} located sensors from "
            f"{network['file']} (sha256 {network['sha256'][:12]}...)"
        )
    else:
        print(
            "Sensor network layer: not present. Add data/nyc/raw/floodnet_network_<date>.json "
            "to draw every FloodNet sensor on the map."
        )
    print(
        f"As of: {card['provenance']['snapshotAsOf']} | "
        f"event dataset updated {card['provenance']['updatedAt']}"
    )


if __name__ == "__main__":
    main()
