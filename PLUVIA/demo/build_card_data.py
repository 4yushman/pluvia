#!/usr/bin/env python3
"""Build the single-event PLUVIA card payload from the frozen FloodNet snapshots."""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CANDIDATES_PATH = ROOT / "data/nyc/selected/replay_candidates_2026-10-10.json"
PROFILES_PATH = ROOT / "data/nyc/raw/floodnet_replay_profiles_2026-10-10.json"
OUTPUT_PATH = Path(__file__).resolve().parent / "card_data.json"
PRIMARY_RANK = "R1-primary"


def load_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def as_array(value, field_name):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a JSON array")
    return value


def number(value, field_name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} contains a non-numeric value")
    if not math.isfinite(value):
        raise ValueError(f"{field_name} contains a non-finite value")
    return value


def utc_iso(value):
    """The source fields are UTC; add an explicit zone without changing the instant."""
    return value if value.endswith("Z") else f"{value}Z"


def build_card():
    candidates = load_json(CANDIDATES_PATH)
    profiles = load_json(PROFILES_PATH)

    selected = [
        row for row in candidates.get("selected", [])
        if row.get("rank") == PRIMARY_RANK
    ]
    if len(selected) != 1:
        raise ValueError(f"Expected exactly one {PRIMARY_RANK} selection")
    event = selected[0]

    matching_profiles = [
        row for row in profiles.get("rows", [])
        if row.get("sensor_id") == event.get("sensor_id")
        and row.get("flood_start_time") == event.get("event_start_utc")
    ]
    if len(matching_profiles) != 1:
        raise ValueError("Expected exactly one matching R1 profile row")
    profile_row = matching_profiles[0]

    for source_field, profile_field in (
        ("sensor_name", "sensor_name"),
        ("event_end_utc", "flood_end_time"),
        ("max_depth_inches", "max_depth_inches"),
        ("duration_mins", "duration_mins"),
        ("tidally_influenced", "tidally_influenced"),
        ("evidence_label", "evidence_label"),
    ):
        if event.get(source_field) != profile_row.get(profile_field):
            raise ValueError(f"Candidate/profile mismatch for {source_field}")

    if event.get("tidally_influenced") != "No":
        raise ValueError("R1 must be verified as non-tidal")
    if event.get("evidence_label") != "measured":
        raise ValueError("R1 must retain its measured evidence label")

    depths = as_array(
        profile_row.get("flood_profile_depth_inches"),
        "flood_profile_depth_inches",
    )
    times = as_array(
        profile_row.get("flood_profile_time_secs"),
        "flood_profile_time_secs",
    )
    if len(depths) != len(times):
        raise ValueError("Profile depth/time arrays have different lengths")
    if len(depths) != 288:
        raise ValueError(f"Expected the verified 288 profile points, got {len(depths)}")

    profile = []
    previous_time = None
    valid_depths = []
    for index, (elapsed_seconds, depth_inches) in enumerate(zip(times, depths)):
        elapsed_seconds = number(elapsed_seconds, f"profile time at index {index}")
        if previous_time is not None and elapsed_seconds <= previous_time:
            raise ValueError("Profile times must be strictly increasing")
        previous_time = elapsed_seconds

        if depth_inches is None:
            # Keep missing measurements explicit so the renderer can leave a gap.
            profile.append({"elapsedSeconds": elapsed_seconds, "depthInches": None})
            continue
        depth_inches = number(depth_inches, f"profile depth at index {index}")
        if depth_inches < 0:
            raise ValueError("Profile depths cannot be negative")
        valid_depths.append(depth_inches)
        profile.append({
            "elapsedSeconds": elapsed_seconds,
            "depthInches": depth_inches,
        })

    max_depth = number(event.get("max_depth_inches"), "max_depth_inches")
    if not valid_depths or not math.isclose(max(valid_depths), max_depth, abs_tol=0.01):
        raise ValueError("Profile maximum does not match the published event maximum")

    candidate_meta = candidates.get("meta", {})
    profile_meta = profiles.get("meta", {})
    if candidate_meta.get("generated_at") != profile_meta.get("generated_at"):
        raise ValueError("Candidate and profile snapshot timestamps do not match")

    source_url = profile_meta.get("source_url")
    snapshot_as_of = profile_meta.get("generated_at")
    updated_at = profile_meta.get("dataset_rows_updated_at")
    if not source_url or not snapshot_as_of or not updated_at:
        raise ValueError("Profile snapshot is missing source/as-of metadata")

    return {
        "event": {
            "sensorId": event["sensor_id"],
            "sensorName": event["sensor_name"],
            "startUtc": utc_iso(event["event_start_utc"]),
            "endUtc": utc_iso(event["event_end_utc"]),
            "maxDepthIn": max_depth,
            "durationMin": number(event["duration_mins"], "duration_mins"),
            "onsetMin": number(event["onset_time_mins"], "onset_time_mins"),
            "drainMin": number(event["drain_time_mins"], "drain_time_mins"),
            "tidalInfluence": event["tidally_influenced"],
            "evidenceLabel": event["evidence_label"],
            "profile": profile,
        },
        "provenance": {
            "dataset": "FloodNet NYC via NYC Open Data",
            "datasetId": "aq7i-eu5q",
            "url": source_url,
            "snapshotAsOf": snapshot_as_of,
            "updatedAt": updated_at,
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
            "refusalNote": "This card replays one historical FloodNet record. It does not establish present road passability or drainage condition, and it says nothing about locations without a selected sensor record.",
        },
    }


def main():
    card = build_card()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as stream:
        json.dump(card, stream, indent=2, ensure_ascii=False)
        stream.write("\n")

    event = card["event"]
    print(f"Wrote {OUTPUT_PATH.relative_to(ROOT)}")
    print(
        f"Event: {event['sensorName']} | {event['startUtc']} | "
        f"max {event['maxDepthIn']:.2f} in | "
        f"duration {event['durationMin']:.2f} min | "
        f"profile points {len(event['profile'])}"
    )
    print(
        f"As of: {card['provenance']['snapshotAsOf']} | "
        f"dataset updated {card['provenance']['updatedAt']}"
    )


if __name__ == "__main__":
    main()
