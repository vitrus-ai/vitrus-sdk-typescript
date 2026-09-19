"""Python SDK facade for Edge-local Cartesian control and camera frames."""

from __future__ import annotations

import base64
import math
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

import httpx


class EdgeControlError(RuntimeError):
    """A rejected, unavailable, or malformed VitrusOS Edge request."""


def _finite_vector(value: Any, size: int, name: str) -> List[float]:
    if not isinstance(value, list) or len(value) != size:
        raise EdgeControlError("%s must contain %d numbers" % (name, size))
    result = [float(item) for item in value]
    if not all(math.isfinite(item) for item in result):
        raise EdgeControlError("%s contains a non-finite number" % name)
    return result


def _auxiliary_targets(raw_targets: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    for raw in raw_targets:
        if not isinstance(raw, dict):
            raise ValueError("auxiliary_joint_targets must contain objects")
        allowed = {"joint_name", "position_deg", "max_torque_nm", "velocity_deg_s"}
        if set(raw) - allowed:
            raise ValueError("unsupported auxiliary target field")
        name = str(raw.get("joint_name", "")).strip()
        position = float(raw.get("position_deg"))
        torque = float(raw.get("max_torque_nm", 0.15))
        velocity = float(raw.get("velocity_deg_s", 30.0))
        if not name or not all(math.isfinite(value) for value in (position, torque, velocity)):
            raise ValueError("auxiliary target values must be finite")
        if not 0 < torque <= 0.35 or not 0 < velocity <= 60:
            raise ValueError("auxiliary target torque/speed exceeds the public SDK envelope")
        result.append({"joint_name": name, "position_deg": position,
                       "max_torque_nm": torque, "velocity_deg_s": velocity})
    if not result:
        raise ValueError("auxiliary_joint_targets cannot be empty")
    return result


@dataclass(frozen=True)
class DeviceIkPose:
    chain: str
    position_m: List[float]
    orientation_xyzw: List[float]
    measured_dq_rad_s: List[float]


@dataclass(frozen=True)
class CameraFrame:
    camera: str
    bytes: bytes
    mime_type: str
    frame_id: Optional[str]
    captured_at: Optional[str]


class MotionJobSession:
    """One immutable-scope V2 motion job; VitrusOS retains the motor lease."""

    def __init__(self, client: "VitrusEdgeClient", job: Dict[str, Any]) -> None:
        self._client = client
        self._job = dict(job)
        self._sequence = int(job.get("last_sequence", 0))
        self._stopped = False

    @property
    def job(self) -> Dict[str, Any]:
        return dict(self._job)

    @property
    def job_id(self) -> str:
        return str(self._job["job_id"])

    @property
    def epoch(self) -> int:
        return int(self._job["epoch"])

    def _identity(self) -> Dict[str, Any]:
        if self._stopped:
            raise EdgeControlError("motion job is already stopped")
        return {"job_id": self.job_id, "epoch": self.epoch}

    def _adopt(self, response: Dict[str, Any]) -> Dict[str, Any]:
        job = response.get("job")
        if isinstance(job, dict):
            self._job = dict(job)
        return response

    async def heartbeat(self, timeout_s: float = 1.2) -> Dict[str, Any]:
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/heartbeat", self._identity(), timeout_s
        )
        return self._adopt(response)

    async def send_pose(
        self,
        chain: str,
        position_m: Iterable[float],
        orientation_xyzw: Iterable[float],
        *,
        duration_ms: int = 2500,
        intent_mode: str = "execute_goal",
        controlled_chains: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        position = _finite_vector(list(position_m), 3, "position_m")
        orientation = _finite_vector(list(orientation_xyzw), 4, "orientation_xyzw")
        if not 1 <= int(duration_ms) <= 60_000:
            raise ValueError("duration_ms must be between 1 and 60000")
        self._sequence += 1
        body = self._identity()
        body.update({
            "sequence": self._sequence,
            "ttl_ms": min(30_000, max(int(duration_ms) + 2_000, int(duration_ms) * 2)),
            "chain": str(chain),
            "controlled_chains": list(controlled_chains or [chain]),
            "task_mode": "pose",
            "intent_mode": intent_mode,
            "points": [{
                "position_m": position,
                "orientation_xyzw": orientation,
                "time_from_start_ms": int(duration_ms),
            }],
        })
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def send_frame(
        self,
        *,
        chain: str,
        position_m: Iterable[float],
        orientation_xyzw: Iterable[float],
        auxiliary_joint_targets: Optional[Iterable[Dict[str, Any]]] = None,
        duration_ms: int = 2500,
        intent_mode: str = "execute_goal",
        controlled_chains: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        """Send one atomic Cartesian pose plus optional declared servo auxiliaries."""
        position = _finite_vector(list(position_m), 3, "position_m")
        orientation = _finite_vector(list(orientation_xyzw), 4, "orientation_xyzw")
        if not 1 <= int(duration_ms) <= 60_000:
            raise ValueError("duration_ms must be between 1 and 60000")
        auxiliary = None
        if auxiliary_joint_targets is not None:
            auxiliary = _auxiliary_targets(auxiliary_joint_targets)
        self._sequence += 1
        body = self._identity()
        body.update({
            "sequence": self._sequence,
            "ttl_ms": min(30_000, max(int(duration_ms) + 2_000, int(duration_ms) * 2)),
            "chain": str(chain),
            "controlled_chains": list(controlled_chains or [chain]),
            "task_mode": "pose",
            "intent_mode": intent_mode,
            "points": [{
                "position_m": position,
                "orientation_xyzw": orientation,
                "time_from_start_ms": int(duration_ms),
            }],
        })
        if auxiliary is not None:
            body["auxiliary_joint_targets"] = auxiliary
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def send_auxiliaries(
        self,
        auxiliary_joint_targets: Iterable[Dict[str, Any]],
        *,
        controlled_chains: Iterable[str],
        duration_ms: int = 500,
        intent_mode: str = "execute_goal",
    ) -> Dict[str, Any]:
        """Atomically update declared servo auxiliaries without invoking Cartesian IK."""
        auxiliary = _auxiliary_targets(auxiliary_joint_targets)
        chains = list(dict.fromkeys(str(chain).strip() for chain in controlled_chains if str(chain).strip()))
        if not chains:
            raise ValueError("controlled_chains cannot be empty")
        if not 1 <= int(duration_ms) <= 60_000:
            raise ValueError("duration_ms must be between 1 and 60000")
        self._sequence += 1
        body = self._identity()
        body.update({
            "sequence": self._sequence,
            "ttl_ms": min(30_000, max(int(duration_ms) + 2_000, int(duration_ms) * 2)),
            "controlled_chains": chains,
            "chain_targets": [],
            "auxiliary_joint_targets": auxiliary,
            "intent_mode": intent_mode,
        })
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def send_position(
        self,
        chain: str,
        position_m: Iterable[float],
        *,
        duration_ms: int = 2500,
        intent_mode: str = "execute_goal",
        controlled_chains: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        """Send a position-prioritized Cartesian target without inventing orientation."""
        position = _finite_vector(list(position_m), 3, "position_m")
        if not 1 <= int(duration_ms) <= 60_000:
            raise ValueError("duration_ms must be between 1 and 60000")
        self._sequence += 1
        body = self._identity()
        body.update({
            "sequence": self._sequence,
            "ttl_ms": min(30_000, max(int(duration_ms) + 2_000, int(duration_ms) * 2)),
            "chain": str(chain),
            "controlled_chains": list(controlled_chains or [chain]),
            "task_mode": "position_only",
            "intent_mode": intent_mode,
            "points": [{"position_m": position, "time_from_start_ms": int(duration_ms)}],
        })
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def hold(self) -> Dict[str, Any]:
        self._sequence += 1
        body = self._identity()
        body.update({"sequence": self._sequence, "operation": "hold"})
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def park_joint_targets(
        self,
        targets: Iterable[Dict[str, Any]],
        *,
        max_velocity_deg_s: float = 5.0,
        tolerance_deg: float = 0.5,
    ) -> Dict[str, Any]:
        """Move the complete admitted joint scope to explicit model-space targets."""
        rows = []
        for raw in targets:
            if not isinstance(raw, dict) or set(raw) != {"joint_name", "position_deg"}:
                raise ValueError("joint targets require joint_name and position_deg")
            name = str(raw["joint_name"]).strip()
            position = float(raw["position_deg"])
            if not name or not math.isfinite(position):
                raise ValueError("joint target values must be finite")
            rows.append({"joint_name": name, "position_deg": position})
        if len(rows) != len(self._job.get("joint_names", [])) or {row["joint_name"] for row in rows} != set(self._job.get("joint_names", [])):
            raise ValueError("joint targets must cover the complete admitted scope")
        speed, tolerance = float(max_velocity_deg_s), float(tolerance_deg)
        if not 0 < speed <= 5 or not 0 < tolerance <= 2:
            raise ValueError("joint park requires speed <=5 deg/s and tolerance <=2 deg")
        self._sequence += 1
        body = self._identity()
        body.update({
            "sequence": self._sequence,
            "operation": "joint_park",
            "targets": rows,
            "max_velocity_deg_s": speed,
            "tolerance_deg": tolerance,
        })
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/update", body, self._client.request_timeout_s
        )
        return self._adopt(response)

    async def stop(self, reason: str = "sdk_client_stop") -> Dict[str, Any]:
        if self._stopped:
            return {"ok": True, "stopped": True, "job": self.job}
        body = {"job_id": self.job_id, "epoch": self.epoch, "reason": reason}
        response = await self._client._motion_request(
            "POST", "/api/v2/motion/stop", body, self._client.request_timeout_s
        )
        self._adopt(response)
        self._stopped = True
        return response


class VitrusEdgeClient:
    """Public Python VitrusSDK client for one local VitrusOS device."""

    def __init__(
        self,
        *,
        robot_id: str,
        motion_endpoint: str = "http://127.0.0.1:8783",
        ik_endpoint: str = "http://127.0.0.1:8782",
        configuration_endpoint: str = "http://127.0.0.1:8781/api/device/configuration",
        camera_endpoint: str = "http://127.0.0.1:8766",
        request_timeout_s: float = 5.0,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        if not robot_id.strip():
            raise ValueError("robot_id is required")
        self.robot_id = robot_id.strip()
        self.motion_endpoint = motion_endpoint.rstrip("/")
        self.ik_endpoint = ik_endpoint.rstrip("/")
        self.configuration_endpoint = configuration_endpoint
        self.camera_endpoint = camera_endpoint.rstrip("/")
        self.request_timeout_s = float(request_timeout_s)
        self._http = http_client or httpx.AsyncClient()
        self._owns_http = http_client is None

    async def __aenter__(self) -> "VitrusEdgeClient":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _json_request(
        self,
        method: str,
        url: str,
        body: Optional[Dict[str, Any]] = None,
        timeout_s: Optional[float] = None,
    ) -> Dict[str, Any]:
        try:
            response = await self._http.request(
                method,
                url,
                json=body,
                headers={"accept": "application/json", "x-vitrus-trace-id": str(uuid.uuid4())},
                timeout=timeout_s or self.request_timeout_s,
            )
        except httpx.HTTPError as error:
            raise EdgeControlError("%s %s failed: %s" % (method, url, error)) from error
        try:
            payload = response.json()
        except ValueError as error:
            raise EdgeControlError("%s %s returned invalid JSON" % (method, url)) from error
        if response.is_error:
            detail = (payload.get("error") or payload.get("detail")) if isinstance(payload, dict) else response.reason_phrase
            raise EdgeControlError("%s %s failed (%d): %s" % (method, url, response.status_code, detail))
        if not isinstance(payload, dict):
            raise EdgeControlError("%s %s returned a non-object response" % (method, url))
        return payload

    async def _motion_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]],
        timeout_s: float,
    ) -> Dict[str, Any]:
        return await self._json_request(method, self.motion_endpoint + path, body, timeout_s)

    async def active_configuration_revision(self) -> str:
        payload = await self._json_request("GET", self.configuration_endpoint, timeout_s=8.0)
        document = payload.get("configuration", payload)
        active = document.get("active") if isinstance(document, dict) else None
        revision = active.get("revision") if isinstance(active, dict) else None
        if not isinstance(revision, str) or not revision.strip():
            raise EdgeControlError("device configuration has no active revision")
        return revision.strip()

    async def current_pose(self, chain: str) -> DeviceIkPose:
        try:
            response = await self._http.get(
                self.ik_endpoint + "/api/dora/ik/current-pose",
                params={"chain": chain},
                headers={"accept": "application/json", "x-vitrus-trace-id": str(uuid.uuid4())},
                timeout=self.request_timeout_s,
            )
        except httpx.HTTPError as error:
            raise EdgeControlError("current pose failed: %s" % error) from error
        if response.is_error:
            raise EdgeControlError("current pose failed (%d): %s" % (response.status_code, response.text))
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("ok") is not True or payload.get("chain") != chain:
            raise EdgeControlError("current pose did not return measured %s" % chain)
        orientation = _finite_vector(payload.get("quaternion"), 4, "quaternion")
        norm = math.sqrt(sum(item * item for item in orientation))
        if abs(norm - 1.0) > 1e-3:
            raise EdgeControlError("measured quaternion is not normalized")
        measured_velocity = payload.get("measured_dq_rad_s")
        if not isinstance(measured_velocity, list):
            raise EdgeControlError("current pose has no measured joint velocity")
        return DeviceIkPose(
            chain=chain,
            position_m=_finite_vector(payload.get("position"), 3, "position"),
            orientation_xyzw=orientation,
            measured_dq_rad_s=_finite_vector(measured_velocity, len(measured_velocity), "measured_dq_rad_s"),
        )

    async def camera_frame(self, camera: str) -> CameraFrame:
        try:
            response = await self._http.get(
                self.camera_endpoint + "/frame/" + camera + ".jpg",
                headers={"accept": "image/jpeg"},
                timeout=self.request_timeout_s,
            )
        except httpx.HTTPError as error:
            raise EdgeControlError("camera %s failed: %s" % (camera, error)) from error
        if response.is_error or not response.content:
            raise EdgeControlError("camera %s failed (%d)" % (camera, response.status_code))
        mime_type = response.headers.get("content-type", "image/jpeg").split(";", 1)[0]
        if mime_type != "image/jpeg":
            raise EdgeControlError("camera %s returned %s" % (camera, mime_type))
        return CameraFrame(
            camera=camera,
            bytes=response.content,
            mime_type=mime_type,
            frame_id=response.headers.get("x-vitrus-frame-id"),
            captured_at=response.headers.get("x-vitrus-captured-at"),
        )

    async def motion_status(self) -> Dict[str, Any]:
        return await self._motion_request("GET", "/api/v2/motion/status", None, self.request_timeout_s)

    async def native_ik_status(self) -> Dict[str, Any]:
        return await self._json_request("GET", self.ik_endpoint + "/api/dora/ik/status", timeout_s=self.request_timeout_s)

    async def start_device_ik(
        self,
        *,
        owner: str,
        joint_names: Iterable[str],
        auxiliary_joint_names: Optional[Iterable[str]] = None,
        auxiliary_joint_limits: Optional[Iterable[Dict[str, Any]]] = None,
        take_over: bool = False,
        configuration_revision: Optional[str] = None,
        client_liveness_ms: int = 10_000,
        intent_mode: str = "execute_goal",
        target_liveness_ms: int = 5_000,
    ) -> MotionJobSession:
        names = list(dict.fromkeys(str(name).strip() for name in joint_names if str(name).strip()))
        if not names:
            raise ValueError("joint_names cannot be empty")
        body: Dict[str, Any] = {
            "mode": "device_ik",
            "owner": owner,
            "joint_names": names,
            **({"take_over": True} if take_over else {}),
            "client_liveness_ms": int(client_liveness_ms),
            "intent_mode": intent_mode,
            "target_liveness_ms": int(target_liveness_ms),
        }
        if self.robot_id:
            body["robot_id"] = self.robot_id
        if auxiliary_joint_names is not None:
            auxiliary = list(dict.fromkeys(str(name).strip() for name in auxiliary_joint_names if str(name).strip()))
            if not auxiliary or any(name not in names for name in auxiliary):
                raise ValueError("auxiliary_joint_names must be a non-empty subset of joint_names")
            body["auxiliary_joint_names"] = auxiliary
            if auxiliary_joint_limits is not None:
                limits = []
                for raw in auxiliary_joint_limits:
                    if not isinstance(raw, dict) or set(raw) != {"joint_name", "max_torque_nm", "velocity_deg_s"}:
                        raise ValueError("auxiliary_joint_limits requires joint_name, max_torque_nm and velocity_deg_s")
                    name = str(raw["joint_name"]).strip()
                    torque = float(raw["max_torque_nm"])
                    velocity = float(raw["velocity_deg_s"])
                    if name not in auxiliary or not all(math.isfinite(value) for value in (torque, velocity)):
                        raise ValueError("auxiliary joint limit is outside the declared scope or non-finite")
                    if not 0 < torque <= 0.35 or not 0 < velocity <= 60:
                        raise ValueError("auxiliary joint limit exceeds the public SDK envelope")
                    limits.append({"joint_name": name, "max_torque_nm": torque, "velocity_deg_s": velocity})
                if len(limits) != len(auxiliary) or {row["joint_name"] for row in limits} != set(auxiliary):
                    raise ValueError("auxiliary_joint_limits must cover the complete auxiliary scope")
                body["auxiliary_joint_limits"] = limits
        if configuration_revision:
            body["configuration_revision"] = configuration_revision
        response = await self._motion_request("POST", "/api/v2/motion/start", body, 20.0)
        job = response.get("job")
        if not isinstance(job, dict):
            raise EdgeControlError("motion start returned no job")
        return MotionJobSession(self, job)


class VitrusDroidClient(VitrusEdgeClient):
    """Device-name client for cameras, measured IK, and motion via the public dataplane."""

    def __init__(
        self,
        *,
        device_name: str,
        api_key: str,
        endpoint: str = "https://vitrus-dataplane.onrender.com",
        request_timeout_s: float = 8.0,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        if not device_name.strip():
            raise ValueError("device_name is required")
        if not api_key.strip():
            raise ValueError("VITRUS_API_KEY is required")
        self.device_name = device_name.strip()
        self.api_key = api_key.strip()
        self.endpoint = endpoint.rstrip("/")
        self.robot_id = ""  # The authenticated device reference replaces Edge robot_id routing.
        self.request_timeout_s = float(request_timeout_s)
        self._http = http_client or httpx.AsyncClient()
        self._owns_http = http_client is None

    def _auth_headers(self, trace_id: Optional[str] = None) -> Dict[str, str]:
        return {
            "accept": "application/json",
            "authorization": "Bearer " + self.api_key,
            "x-vitrus-trace-id": trace_id or str(uuid.uuid4()),
        }

    async def _public_json(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, str]] = None,
        timeout_s: Optional[float] = None,
    ) -> Dict[str, Any]:
        query = {"ref": self.device_name, **(params or {})}
        trace_id = str(uuid.uuid4())
        try:
            response = await self._http.request(
                method, self.endpoint + path, params=query, json=body,
                headers={**self._auth_headers(trace_id), "content-type": "application/json"},
                timeout=timeout_s or self.request_timeout_s,
            )
        except httpx.HTTPError as error:
            raise EdgeControlError("public %s failed: %s" % (path, error)) from error
        try:
            payload = response.json()
        except ValueError as error:
            if response.is_error:
                raise EdgeControlError(
                    "public %s failed (%d): %s" % (path, response.status_code, response.text[:240])
                ) from error
            raise EdgeControlError("public %s returned invalid JSON" % path) from error
        if response.is_error:
            detail = payload.get("error") or payload.get("detail") if isinstance(payload, dict) else response.reason_phrase
            raise EdgeControlError("public %s failed (%d): %s" % (path, response.status_code, detail))
        if not isinstance(payload, dict):
            raise EdgeControlError("public %s returned a non-object response" % path)
        return payload

    async def _motion_request(
        self, method: str, path: str, body: Optional[Dict[str, Any]], timeout_s: float,
    ) -> Dict[str, Any]:
        operation = path.rsplit("/", 1)[-1]
        if operation not in {"status", "execution", "feedback", "pose", "start", "update", "heartbeat", "stop", "safety-stop"}:
            raise EdgeControlError("unsupported public motion operation: " + operation)
        timeout_ms = max(250, min(60_000, int(timeout_s * 1000)))
        return await self._public_json(
            "POST", "/v1/droids/motion/direct/" + operation,
            body={"request_id": str(uuid.uuid4()), "payload": body or {}, "timeout_ms": timeout_ms},
            timeout_s=timeout_s,
        )

    async def description(self) -> Dict[str, Any]:
        return await self._public_json("GET", "/v1/droids/description")

    async def telemetry(self) -> Dict[str, Any]:
        return await self._public_json("GET", "/v1/droids/telemetry")

    async def active_configuration_revision(self) -> str:
        document = await self.description()

        def find(value: Any) -> Optional[str]:
            if isinstance(value, dict):
                for key in ("configuration_revision", "configurationRevision", "revision"):
                    candidate = value.get(key)
                    if isinstance(candidate, str) and candidate.strip():
                        return candidate.strip()
                for child in value.values():
                    found = find(child)
                    if found:
                        return found
            elif isinstance(value, list):
                for child in value:
                    found = find(child)
                    if found:
                        return found
            return None

        revision = find(document)
        if not revision:
            raise EdgeControlError("public device description has no configuration revision")
        return revision

    async def native_ik_status(self) -> Dict[str, Any]:
        result = await self._motion_request("POST", "/api/v2/motion/execution", {}, self.request_timeout_s)
        execution = result.get("execution", result)
        return execution if isinstance(execution, dict) else result

    async def motion_feedback(self) -> Dict[str, Any]:
        return await self._motion_request("POST", "/api/v2/motion/feedback", {}, self.request_timeout_s)

    async def current_pose(self, chain: str) -> DeviceIkPose:
        measured = await self._motion_request(
            "POST", "/api/v2/motion/pose", {"chain": chain}, self.request_timeout_s
        )
        if measured.get("ok") is not True or measured.get("chain") != chain:
            raise EdgeControlError("public pose did not return measured %s" % chain)
        orientation = _finite_vector(measured.get("quaternion"), 4, "quaternion")
        norm = math.sqrt(sum(item * item for item in orientation))
        if abs(norm - 1.0) > 1e-3:
            raise EdgeControlError("measured quaternion is not normalized")
        velocity = measured.get("measured_dq_rad_s")
        if not isinstance(velocity, list):
            velocity = [0.0]
        return DeviceIkPose(
            chain=chain,
            position_m=_finite_vector(measured.get("position"), 3, "position"),
            orientation_xyzw=orientation,
            measured_dq_rad_s=_finite_vector(velocity, len(velocity), "measured_dq_rad_s"),
        )

    async def camera_frame(self, camera: str) -> CameraFrame:
        payload = await self._public_json(
            "GET", "/v1/droids/cameras/frame",
            params={"camera": camera},
        )
        encoded = payload.get("dataBase64", payload.get("data_base64"))
        if not isinstance(encoded, str):
            raise EdgeControlError("public camera %s returned no frame bytes" % camera)
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise EdgeControlError("public camera %s returned invalid base64" % camera) from error
        if not data:
            raise EdgeControlError("public camera %s returned an empty frame" % camera)
        return CameraFrame(
            camera=camera, bytes=data,
            mime_type=str(payload.get("mimeType", payload.get("mime_type", "image/jpeg"))),
            frame_id=payload.get("frameId", payload.get("frame_id")),
            captured_at=payload.get("capturedAt", payload.get("captured_at")),
        )
