import json

import httpx
import pytest

from vitrus.device_status import DEVICE_STATUS_SCHEMA, normalize_device_status
from vitrus.droid import Droid


def fixture():
    return {
        "schema": DEVICE_STATUS_SCHEMA,
        "schema_version": "1.0.0",
        "device_id": "11111111-1111-4111-8111-111111111111",
        "serial_number": "VTRS-R06-2607-R2D2X",
        "model": "R06",
        "timestamp": "2026-08-25T20:00:00Z",
        "sequence": 7,
        "state": "online",
        "connection": {"sdk_agent": "connected", "bridge": "connected", "edge_local": True, "last_connected_at": "2026-08-25T19:59:58Z"},
        "safety": {"state": "safe", "estop": False, "deadman_active": False, "deadman_latched": False, "faults": []},
        "control": {"mode": "read_only", "phase": "read_only", "owner": None, "lease_id": None, "lease_expires_at": None},
        "robot": {
            "description_revision": "sha256:" + "1" * 64,
            "configuration_revision": "sha256:" + "2" * 64,
            "calibration_revision": "sha256:" + "3" * 64,
            "joint_count": 26,
            "available_joint_count": 26,
        },
        "telemetry": {"schema": "vitrus.telemetry.state.v1", "sequence": 9, "sampled_at": "2026-08-25T20:00:00Z", "age_ms": 12.5, "complete": True, "stale": False},
        "components": {"motor_broker": {"state": "ok"}, "sdk_agent": {"state": "ok"}},
        "errors": [],
        "extensions": {"vitrus_os": {"release": "test"}},
    }


def test_strict_status_rejects_impossible_authority_and_bad_revision():
    assert normalize_device_status(fixture()) == fixture()

    invalid_authority = fixture()
    invalid_authority["control"] = {"mode": "read_only", "phase": "read_only", "owner": "old", "lease_id": "old", "lease_expires_at": "2026-08-25T20:01:00Z"}
    with pytest.raises(TypeError, match="cannot expose"):
        normalize_device_status(invalid_authority)

    invalid_revision = fixture()
    invalid_revision["robot"] = dict(invalid_revision["robot"], configuration_revision="sha256:not-a-hash")
    with pytest.raises(TypeError, match="SHA-256"):
        normalize_device_status(invalid_revision)


@pytest.mark.asyncio
async def test_droid_status_snapshot_uses_edge_contract_without_bridge_credentials():
    status = fixture()
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=status)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    droid = Droid("R-06", "bridge-key", edge_status_url="http://r06-edge/v1/device/status", http_client=client)
    assert await droid.status.snapshot() == status
    assert requests[0].headers.get("authorization") is None
    await client.aclose()


class FakeSession:
    def declare_subscriber(self, topic, callback):
        self.topic = topic
        self.callback = callback
        return type("Subscription", (), {"undeclare": lambda self: None})()


def test_status_subscription_normalizes_the_same_contract():
    session = FakeSession()
    droid = Droid("R-06", "key", zenoh_session=session)
    received = []
    droid.status.subscribe(received.append)
    session.callback(type("Sample", (), {"payload": json.dumps(fixture()).encode("utf-8")})())
    assert session.topic == "vitrus/device/status"
    assert received == [fixture()]
