"""Minimal, closed-choice PLUVIA verification intake handler."""

import base64
import binascii
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

# These IDs are the event IDs in PLUVIA/demo/card_data.json for this snapshot.
ALLOWED_EVENT_IDS = frozenset({"R1-primary", "R2", "R3", "backup"})
ALLOWED_OBSERVATIONS = frozenset(
    {"water_visible", "no_water_visible", "not_sure"}
)
_TABLE = None


def _request_id(context):
    return getattr(context, "aws_request_id", None) or "unavailable"


def _log(context, outcome):
    # Never include the submitted body, event ID, observation, or exception text.
    LOGGER.info(
        json.dumps(
            {"requestId": _request_id(context), "outcome": outcome},
            separators=(",", ":"),
        )
    )


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def _decode_body(event):
    if not isinstance(event, dict):
        return None
    body = event.get("body")
    if not isinstance(body, str):
        return None
    if event.get("isBase64Encoded") is True:
        try:
            return base64.b64decode(body, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return None
    return body


def _get_table():
    global _TABLE
    if _TABLE is None:
        import boto3

        _TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _TABLE


def handler(event, context):
    body = _decode_body(event)
    if body is None:
        _log(context, "invalid_request")
        return _response(400, {"error": "invalid_request"})

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        _log(context, "invalid_request")
        return _response(400, {"error": "invalid_request"})

    if not isinstance(payload, dict) or set(payload) != {"eventId", "observation"}:
        _log(context, "invalid_request")
        return _response(400, {"error": "invalid_request"})

    event_id = payload["eventId"]
    observation = payload["observation"]
    if not isinstance(event_id, str) or event_id not in ALLOWED_EVENT_IDS:
        _log(context, "invalid_event_id")
        return _response(400, {"error": "invalid_event_id"})
    if not isinstance(observation, str) or observation not in ALLOWED_OBSERVATIONS:
        _log(context, "invalid_observation")
        return _response(400, {"error": "invalid_observation"})

    received_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    submission_id = str(uuid.uuid4())
    item = {
        "PK": f"EVENT#{event_id}",
        "SK": f"REPORT#{received_at}#{submission_id}",
        "eventId": event_id,
        "observation": observation,
        "evidenceType": "reported",
        "receivedAt": received_at,
        "submissionId": submission_id,
        "expiresAt": int(time.time()) + 30 * 24 * 60 * 60,
    }

    try:
        _get_table().put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
        )
    except Exception:
        # Do not emit exception details; SDK errors can contain request data.
        _log(context, "write_failed")
        return _response(500, {"error": "storage_unavailable"})

    _log(context, "accepted")
    return _response(
        201,
        {
            "status": "received",
            "evidenceType": "reported",
            "receivedAt": received_at,
            "submissionId": submission_id,
        },
    )
