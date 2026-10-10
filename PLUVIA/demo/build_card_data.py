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
OUTPUT_PATH = DEMO / "card_data.json"
DEFAULT_EVENT_ID = "R1-primary"


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
    return {
        "defaultEventId": DEFAULT_EVENT_ID,
        "events": events,
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
    print(
        f"As of: {card['provenance']['snapshotAsOf']} | "
        f"event dataset updated {card['provenance']['updatedAt']}"
    )


if __name__ == "__main__":
    main()
