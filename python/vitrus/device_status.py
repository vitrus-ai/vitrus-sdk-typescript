"""Strict public Vitrus device-status contract.

This module deliberately knows nothing about CAN, TTL, Dora, or broker internals.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Dict, Iterable, Optional


DEVICE_STATUS_SCHEMA = "vitrus.device.status.v1"
DEVICE_STATUS_VERSION = "1.0.0"
_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")


def _record(value: Any, field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("%s must be an object" % field)
    return value


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError("%s must be a non-empty string" % field)
    return value


def _nullable_string(value: Any, field: str) -> Optional[str]:
    return None if value is None else _string(value, field)


def _timestamp(value: Any, field: str) -> str:
    result = _string(value, field)
    try:
        datetime.datetime.fromisoformat(result.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TypeError("%s must be an RFC3339 timestamp" % field) from exc
    return result


def _nullable_timestamp(value: Any, field: str) -> Optional[str]:
    return None if value is None else _timestamp(value, field)


def _integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError("%s must be a non-negative integer" % field)
    return value


def _nullable_integer(value: Any, field: str) -> Optional[int]:
    return None if value is None else _integer(value, field)


def _nullable_number(value: Any, field: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise TypeError("%s must be a non-negative finite number or null" % field)
    result = float(value)
    if result == float("inf") or result == float("-inf") or result != result:
        raise TypeError("%s must be a non-negative finite number or null" % field)
    return value


def _boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError("%s must be a boolean" % field)
    return value


def _one_of(value: Any, field: str, values: Iterable[str]) -> str:
    choices = tuple(values)
    if not isinstance(value, str) or value not in choices:
        raise TypeError("%s must be one of %s" % (field, ", ".join(choices)))
    return value


def _revision(value: Any, field: str) -> Optional[str]:
    result = _nullable_string(value, field)
    if result is not None and not _REVISION.match(result):
        raise TypeError("%s must be a lowercase SHA-256 revision or null" % field)
    return result


def _errors(value: Any, field: str) -> list:
    if not isinstance(value, list):
        raise TypeError("%s must be an array" % field)
    result = []
    for index, item in enumerate(value):
        name = "%s[%d]" % (field, index)
        raw = _record(item, name)
        error = {
            "code": _string(raw.get("code"), name + ".code"),
            "message": _string(raw.get("message"), name + ".message"),
            "severity": _one_of(raw.get("severity"), name + ".severity", ("warning", "error")),
        }
        if raw.get("component") is not None:
            error["component"] = _string(raw.get("component"), name + ".component")
        result.append(error)
    return result


def normalize_device_status(value: Any) -> Dict[str, Any]:
    """Validate and normalize one ``vitrus.device.status.v1`` snapshot."""
    raw = _record(value, "status")
    if raw.get("schema") != DEVICE_STATUS_SCHEMA:
        raise TypeError("status.schema must be %s" % DEVICE_STATUS_SCHEMA)
    version = _string(raw.get("schema_version"), "status.schema_version")
    if version.split(".", 1)[0] != DEVICE_STATUS_VERSION.split(".", 1)[0]:
        raise TypeError("unsupported status.schema_version %s" % version)

    connection = _record(raw.get("connection"), "status.connection")
    safety = _record(raw.get("safety"), "status.safety")
    control = _record(raw.get("control"), "status.control")
    robot = _record(raw.get("robot"), "status.robot")
    telemetry = _record(raw.get("telemetry"), "status.telemetry")
    components = _record(raw.get("components"), "status.components")

    mode = _one_of(control.get("mode"), "status.control.mode", ("read_only", "read_write"))
    owner = _nullable_string(control.get("owner"), "status.control.owner")
    lease_id = _nullable_string(control.get("lease_id"), "status.control.lease_id")
    lease_expires_at = _nullable_timestamp(control.get("lease_expires_at"), "status.control.lease_expires_at")
    if mode == "read_write" and not (owner and lease_id and lease_expires_at):
        raise TypeError("read_write status requires owner, lease_id and lease_expires_at")
    if mode == "read_only" and (owner or lease_id or lease_expires_at):
        raise TypeError("read_only status cannot expose write authority")

    joint_count = _integer(robot.get("joint_count"), "status.robot.joint_count")
    available_count = _integer(robot.get("available_joint_count"), "status.robot.available_joint_count")
    if available_count > joint_count:
        raise TypeError("available_joint_count cannot exceed joint_count")
    if telemetry.get("schema") != "vitrus.telemetry.state.v1":
        raise TypeError("status.telemetry.schema must be vitrus.telemetry.state.v1")

    normalized_components = {}
    for name, item in components.items():
        component = _record(item, "status.components.%s" % name)
        result = {"state": _one_of(component.get("state"), "status.components.%s.state" % name, ("ok", "degraded", "unavailable", "fault"))}
        if component.get("message") is not None:
            result["message"] = _string(component.get("message"), "status.components.%s.message" % name)
        normalized_components[name] = result

    return {
        "schema": DEVICE_STATUS_SCHEMA,
        "schema_version": version,
        "device_id": _string(raw.get("device_id"), "status.device_id"),
        "serial_number": _string(raw.get("serial_number"), "status.serial_number"),
        "model": _string(raw.get("model"), "status.model"),
        "timestamp": _timestamp(raw.get("timestamp"), "status.timestamp"),
        "sequence": _integer(raw.get("sequence"), "status.sequence"),
        "state": _one_of(raw.get("state"), "status.state", ("online", "degraded", "offline", "starting", "stopping", "fault")),
        "connection": {
            "sdk_agent": _one_of(connection.get("sdk_agent"), "status.connection.sdk_agent", ("connected", "reconnecting", "disconnected", "misconfigured", "not_configured")),
            "bridge": _one_of(connection.get("bridge"), "status.connection.bridge", ("connected", "reconnecting", "disconnected", "misconfigured", "not_configured")),
            "edge_local": _boolean(connection.get("edge_local"), "status.connection.edge_local"),
            "last_connected_at": _nullable_timestamp(connection.get("last_connected_at"), "status.connection.last_connected_at"),
        },
        "safety": {
            "state": _one_of(safety.get("state"), "status.safety.state", ("safe", "warning", "fault", "estopped")),
            "estop": _boolean(safety.get("estop"), "status.safety.estop"),
            "deadman_active": _boolean(safety.get("deadman_active"), "status.safety.deadman_active"),
            "deadman_latched": _boolean(safety.get("deadman_latched"), "status.safety.deadman_latched"),
            "faults": _errors(safety.get("faults"), "status.safety.faults"),
        },
        "control": {"mode": mode, "phase": _string(control.get("phase"), "status.control.phase"), "owner": owner, "lease_id": lease_id, "lease_expires_at": lease_expires_at},
        "robot": {
            "description_revision": _revision(robot.get("description_revision"), "status.robot.description_revision"),
            "configuration_revision": _revision(robot.get("configuration_revision"), "status.robot.configuration_revision"),
            "calibration_revision": _revision(robot.get("calibration_revision"), "status.robot.calibration_revision"),
            "joint_count": joint_count,
            "available_joint_count": available_count,
        },
        "telemetry": {
            "schema": "vitrus.telemetry.state.v1",
            "sequence": _nullable_integer(telemetry.get("sequence"), "status.telemetry.sequence"),
            "sampled_at": _nullable_timestamp(telemetry.get("sampled_at"), "status.telemetry.sampled_at"),
            "age_ms": _nullable_number(telemetry.get("age_ms"), "status.telemetry.age_ms"),
            "complete": _boolean(telemetry.get("complete"), "status.telemetry.complete"),
            "stale": _boolean(telemetry.get("stale"), "status.telemetry.stale"),
        },
        "components": normalized_components,
        "errors": _errors(raw.get("errors"), "status.errors"),
        "extensions": _record(raw.get("extensions"), "status.extensions"),
    }
