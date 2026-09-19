import asyncio
import base64
import json

import httpx
from vitrus.edge_control import VitrusDroidClient, VitrusEdgeClient


def test_edge_sdk_reads_pose_camera_and_sends_full_pose():
    requests = []

    def handler(request):
        requests.append(request)
        path = request.url.path
        if path == "/configuration":
            return httpx.Response(200, json={"configuration": {"active": {"revision": "rev-7"}}})
        if path == "/api/dora/ik/current-pose":
            assert request.url.params["chain"] == "RIGHT_ARM"
            return httpx.Response(200, json={
                "ok": True, "chain": "RIGHT_ARM", "position": [0.1, 0.2, 0.3],
                "quaternion": [0, 0, 0, 1], "measured_dq_rad_s": [0] * 7,
            })
        if path == "/frame/right_wrist.jpg":
            return httpx.Response(200, content=b"jpeg", headers={"content-type": "image/jpeg"})
        if path == "/api/v2/motion/start":
            body = json.loads(request.content)
            assert body["mode"] == "device_ik"
            assert body["take_over"] is True
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "job-1", "epoch": 2, "last_sequence": 4, "state": "active",
            }})
        if path == "/api/v2/motion/update":
            body = json.loads(request.content)
            assert body["sequence"] == 5
            assert body["points"][0]["position_m"] == [0.1, 0.2, 0.35]
            assert body["points"][0]["orientation_xyzw"] == [0.0, 0.0, 0.0, 1.0]
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "job-1", "epoch": 2, "last_sequence": 5, "state": "active",
            }})
        raise AssertionError("unexpected request %s" % request.url)

    async def exercise():
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        sdk = VitrusEdgeClient(
            robot_id="r06", motion_endpoint="http://edge", ik_endpoint="http://edge",
            configuration_endpoint="http://edge/configuration", camera_endpoint="http://edge",
            http_client=http,
        )
        assert await sdk.active_configuration_revision() == "rev-7"
        pose = await sdk.current_pose("RIGHT_ARM")
        assert pose.position_m == [0.1, 0.2, 0.3]
        assert (await sdk.camera_frame("right_wrist")).bytes == b"jpeg"
        session = await sdk.start_device_ik(
            owner="test", joint_names=["RIGHT_SHOULDER_A"], take_over=True,
            configuration_revision="rev-7"
        )
        await session.send_pose("RIGHT_ARM", [0.1, 0.2, 0.35], [0, 0, 0, 1])
        await http.aclose()

    asyncio.run(exercise())
    assert len(requests) == 5


def test_edge_sdk_sends_atomic_pose_and_gripper_auxiliaries():
    observed = {}

    def handler(request):
        body = json.loads(request.content)
        if request.url.path == "/api/v2/motion/start":
            observed["start"] = body
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "job-aux", "epoch": 3, "last_sequence": 0, "state": "active",
            }})
        if request.url.path == "/api/v2/motion/update":
            observed["update"] = body
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "job-aux", "epoch": 3, "last_sequence": 1, "state": "active",
            }})
        raise AssertionError("unexpected request %s" % request.url)

    async def exercise():
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        sdk = VitrusEdgeClient(robot_id="r06", motion_endpoint="http://edge", http_client=http)
        fingers = ["RIGHT_GRIPPER_LEFT_FINGER_A", "RIGHT_GRIPPER_RIGHT_FINGER_A"]
        session = await sdk.start_device_ik(
            owner="astra", joint_names=["RIGHT_SHOULDER_A", *fingers],
            auxiliary_joint_names=fingers, take_over=True,
        )
        await session.send_frame(
            chain="RIGHT_ARM", position_m=[0.1, 0.2, 0.3], orientation_xyzw=[0, 0, 0, 1],
            auxiliary_joint_targets=[
                {"joint_name": fingers[0], "position_deg": -40, "max_torque_nm": .15, "velocity_deg_s": 30},
                {"joint_name": fingers[1], "position_deg": 20, "max_torque_nm": .15, "velocity_deg_s": 30},
            ],
        )
        await http.aclose()

    asyncio.run(exercise())
    assert observed["start"]["auxiliary_joint_names"] == [
        "RIGHT_GRIPPER_LEFT_FINGER_A", "RIGHT_GRIPPER_RIGHT_FINGER_A"
    ]
    assert len(observed["update"]["auxiliary_joint_targets"]) == 2


def test_device_name_sdk_uses_only_authenticated_public_routes():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.host == "dataplane.example"
        assert request.url.params["ref"] == "VTRS-R06"
        assert request.headers["authorization"] == "Bearer secret"
        path = request.url.path
        if path == "/v1/droids/description":
            return httpx.Response(200, json={"configurationRevision": "rev-public"})
        if path == "/v1/droids/cameras/frame":
            return httpx.Response(200, json={
                "camera": "right_wrist", "mimeType": "image/jpeg",
                "frameId": "frame-1", "capturedAt": "2026-09-18T00:00:00Z",
                "dataBase64": base64.b64encode(b"jpeg-public").decode(),
            })
        envelope = json.loads(request.content)
        assert set(envelope) == {"request_id", "payload", "timeout_ms"}
        payload = envelope["payload"]
        if path.endswith("/start"):
            assert "robot_id" not in payload
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "public-job", "epoch": 1, "last_sequence": 0, "state": "hold",
            }})
        if path.endswith("/pose"):
            assert payload == {"chain": "RIGHT_ARM"}
            return httpx.Response(200, json={
                "ok": True, "chain": "RIGHT_ARM", "position": [0.1, 0.2, 0.3],
                "quaternion": [0, 0, 0, 1], "measured_dq_rad_s": [0.01],
            })
        if path.endswith("/update"):
            return httpx.Response(200, json={"ok": True, "job": {
                "job_id": "public-job", "epoch": 1, "last_sequence": 1, "state": "active",
            }})
        raise AssertionError("unexpected request %s" % request.url)

    async def exercise():
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        sdk = VitrusDroidClient(
            device_name="VTRS-R06", api_key="secret", endpoint="https://dataplane.example",
            http_client=http,
        )
        assert await sdk.active_configuration_revision() == "rev-public"
        assert (await sdk.camera_frame("right_wrist")).bytes == b"jpeg-public"
        pose = await sdk.current_pose("RIGHT_ARM")
        assert pose.position_m == [0.1, 0.2, 0.3]
        session = await sdk.start_device_ik(owner="test", joint_names=["RIGHT_SHOULDER_A"], take_over=True)
        await session.send_pose("RIGHT_ARM", [0.1, 0.2, 0.31], [0, 0, 0, 1])
        await http.aclose()

    asyncio.run(exercise())
    assert all("127.0.0.1" not in str(request.url) for request in requests)
