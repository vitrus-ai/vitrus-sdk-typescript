"""Device-first Vitrus Droid client with Zenoh motion transport."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Iterable, Optional
from urllib.parse import quote

import httpx

try:
    import zenoh  # type: ignore
except Exception:  # pragma: no cover - optional at import time
    zenoh = None


DEFAULT_BRIDGE_URL = "https://vitrus-dataplane.onrender.com"
DEFAULT_ZENOH_ENDPOINT = "tcp/127.0.0.1:7447"
DEFAULT_ZENOH_TOPIC = "vitrus/servo/targets"
DEFAULT_TELEMETRY_TOPIC = "vitrus/state/motor_state"


class TelemetrySubscription:
    """Closable native Zenoh telemetry subscription shared by many clients."""

    def __init__(self, subscriber: Any) -> None:
        self._subscriber = subscriber

    def close(self) -> None:
        undeclare = getattr(self._subscriber, "undeclare", None)
        if callable(undeclare):
            undeclare()


class Droid:
    """Connect to a Vitrus droid with Bridge leases and native Zenoh targets."""

    def __init__(
        self,
        name: str,
        api_key: str,
        *,
        bridge_url: str = DEFAULT_BRIDGE_URL,
        zenoh_endpoint: str = DEFAULT_ZENOH_ENDPOINT,
        zenoh_topic: str = DEFAULT_ZENOH_TOPIC,
        telemetry_topic: str = DEFAULT_TELEMETRY_TOPIC,
        http_client: Optional[httpx.AsyncClient] = None,
        zenoh_session: Any = None,
    ) -> None:
        self.name = name.strip()
        self.api_key = api_key.strip()
        self.bridge_url = bridge_url.rstrip("/")
        self.zenoh_endpoint = zenoh_endpoint
        self.zenoh_topic = zenoh_topic
        self.telemetry_topic = telemetry_topic
        self._http = http_client
        self._owns_http = http_client is None
        self._zenoh = zenoh_session
        self._sequence = 0
        self._identity: Optional[Dict[str, Any]] = None
        if not self.name:
            raise ValueError("DROID_NAME is required")
        if not self.api_key:
            raise ValueError("VITRUS_API_KEY is required")

    @classmethod
    async def connect(cls, name: str, api_key: str, **kwargs: Any) -> "Droid":
        droid = cls(name, api_key, **kwargs)
        await droid.identity()
        return droid

    @classmethod
    async def from_env(cls, **kwargs: Any) -> "Droid":
        name = os.environ.get("VITRUS_DROID", os.environ.get("DROID_NAME", "")).strip()
        api_key = os.environ.get("VITRUS_API_KEY", "").strip()
        bridge_url = os.environ.get("VITRUS_API_URL", DEFAULT_BRIDGE_URL)
        zenoh_endpoint = os.environ.get("VITRUS_ZENOH_TCP_ENDPOINT", DEFAULT_ZENOH_ENDPOINT)
        zenoh_topic = os.environ.get("VITRUS_ZENOH_TOPIC", DEFAULT_ZENOH_TOPIC)
        telemetry_topic = os.environ.get("VITRUS_ZENOH_TELEMETRY_TOPIC", DEFAULT_TELEMETRY_TOPIC)
        return await cls.connect(
            name,
            api_key,
            bridge_url=bridge_url,
            zenoh_endpoint=zenoh_endpoint,
            zenoh_topic=zenoh_topic,
            telemetry_topic=telemetry_topic,
            **kwargs,
        )

    async def identity(self) -> Dict[str, Any]:
        if self._identity is not None:
            return self._identity
        response = await self._request("GET", "/v1/droids/resolve", params={"ref": self.name})
        self._identity = response
        transports = response.get("transports")
        if isinstance(transports, dict):
            advertised = transports.get("zenohTcp") or transports.get("zenoh_tcp")
            if isinstance(advertised, str) and advertised.strip():
                self.zenoh_endpoint = advertised.strip()
        return response

    async def acquire(self, duration_ms: int = 5000, owner: str = "vitrus-python") -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/droids/control/leases",
            params={"ref": self.name},
            json={"durationMs": duration_ms, "owner": owner},
        )

    async def renew(self, lease_id: str, duration_ms: int = 5000) -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/droids/control/leases/" + quote(lease_id, safe=""),
            params={"ref": self.name},
            json={"durationMs": duration_ms},
        )

    async def release(self, lease_id: str) -> None:
        await self._request(
            "DELETE",
            "/v1/droids/control/leases/" + quote(lease_id, safe=""),
            params={"ref": self.name},
        )

    def subscribe_telemetry(self, callback: Any) -> TelemetrySubscription:
        """Subscribe to normalized state without polling the motor broker."""
        session = self._zenoh or self._open_zenoh()
        self._zenoh = session

        def on_sample(sample: Any) -> None:
            payload = getattr(sample, "payload", sample)
            if hasattr(payload, "to_bytes"):
                payload = payload.to_bytes()
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode("utf-8")
            callback(json.loads(payload) if isinstance(payload, str) else payload)

        subscriber = session.declare_subscriber(self.telemetry_topic, on_sample)
        return TelemetrySubscription(subscriber)

    async def send_targets(
        self,
        targets: Iterable[Dict[str, Any]],
        lease_id: str,
        *,
        ttl_ms: int = 250,
        source: str = "vitrus-python",
    ) -> Dict[str, Any]:
        identity = await self.identity()
        normalized = [dict(target) for target in targets]
        if not normalized:
            raise ValueError("send_targets requires at least one target")
        self._sequence += 1
        sent_at_ms = int(__import__("time").time() * 1000)
        command = {
            "schema": "vitrus.control.joint_targets",
            "schema_version": "0.1.0",
            "source": source,
            "lease_id": lease_id,
            "seq": self._sequence,
            "issued_at_ms": sent_at_ms,
            "deadline_ms": sent_at_ms + max(1, int(ttl_ms)),
            "target": self._edge_target(normalized[0]),
            "robot_id": str(identity["id"]),
        }
        session = self._zenoh_session or self._open_zenoh()
        self._zenoh_session = session
        for target in normalized:
            command["target"] = self._edge_target(target)
            session.put(self.zenoh_topic, json.dumps(command, separators=(",", ":")).encode("utf-8"))
        return {
            "requestId": str(self._sequence),
            "status": "acknowledged",
            "route": "local",
            "result": {"transport": "zenoh", "stream": "joint_targets", "published": len(normalized)},
        }

    async def close(self) -> None:
        if self._zenoh is not None:
            close = getattr(self._zenoh, "close", None)
            if callable(close):
                close()
            self._zenoh = None
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    def _open_zenoh(self) -> Any:
        if zenoh is None:
            raise RuntimeError("eclipse-zenoh is required for Droid motion")
        config = zenoh.Config()
        endpoints = json.dumps([self.zenoh_endpoint])
        if hasattr(config, "insert_json5"):
            config.insert_json5("mode", '"client"')
            config.insert_json5("connect/endpoints", endpoints)
        else:
            config.insert_json("mode", '"client"')
            config.insert_json("connect/endpoints", endpoints)
        return zenoh.open(config)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=15)
        headers = dict(kwargs.pop("headers", {}))
        headers["authorization"] = "Bearer " + self.api_key
        response = await self._http.request(method, self.bridge_url + path, headers=headers, **kwargs)
        payload = response.json()
        if response.is_error:
            detail = payload.get("detail") if isinstance(payload, dict) else response.reason_phrase
            raise RuntimeError("Vitrus Droid request failed (%s): %s" % (response.status_code, detail))
        return payload

    @staticmethod
    def _edge_target(target: Dict[str, Any]) -> Dict[str, Any]:
        result = dict(target)
        if "position_deg" in result and "display_deg" not in result:
            result["display_deg"] = result.pop("position_deg")
        if "velocity_deg_s" in result and "speed_deg_s" not in result:
            result["speed_deg_s"] = result.pop("velocity_deg_s")
        return result
