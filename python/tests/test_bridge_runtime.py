import pytest

from vitrus import Vitrus


class FakeBridgeVitrus(Vitrus):
    def __init__(self):
        super().__init__(api_key="test-key", world="lab", bridge_url="http://bridge.test")
        self.requests = []
        self.devices = []
        self.actors = []

    async def _bridge_request(self, method, path, json_body=None, params=None):
        self.requests.append({"method": method, "path": path, "json": json_body, "params": params})
        if method == "POST" and path == "/devices":
            device = {"id": "dev_1", **json_body, "status": "online", "actors": []}
            self.devices = [device]
            return {"device": device}
        if method == "POST" and path == "/actors":
            actor = {"id": "act_1", **json_body, "status": "ready"}
            self.actors = [actor]
            return {"actor": actor}
        if method == "GET" and path == "/devices":
            return {"devices": self.devices}
        if method == "GET" and path == "/actors":
            return {"actors": self.actors}
        if method == "POST" and path == "/actors/act_1/commands/estimate_depth":
            return {"request_id": "cmd_1", "status": "acknowledged", "result": {"ok": True}}
        if method == "POST" and path == "/devices/dev_1/emergency-stop":
            return {"request_id": "cmd_stop", "status": "acknowledged", "result": {"stopped": True}}
        if method == "POST" and path.endswith("/heartbeat"):
            return {}
        raise AssertionError(f"Unexpected bridge request: {method} {path}")


@pytest.mark.asyncio
async def test_device_runtime_registers_device_and_actor():
    vitrus = FakeBridgeVitrus()
    device = await vitrus.device(key="gpu-box", name="GPU Box", kind="computer")
    actor = device.actor("vision.depth_anything.v1", capabilities=["vision.depth"])

    @actor.command("estimate_depth")
    async def estimate_depth(image_url: str):
        return {"image_url": image_url}

    await device.register_actors()

    assert vitrus.requests[0]["path"] == "/devices"
    assert vitrus.requests[0]["json"]["key"] == "gpu-box"
    assert vitrus.requests[1]["path"] == "/actors"
    assert vitrus.requests[1]["json"]["commands"][0]["name"] == "estimate_depth"


@pytest.mark.asyncio
async def test_bridge_actor_handle_runs_command():
    vitrus = FakeBridgeVitrus()
    device = await vitrus.device(key="gpu-box", name="GPU Box", kind="computer")
    actor = device.actor("vision.depth_anything.v1", capabilities=["vision.depth"])
    await device.register_actors()

    handle = await vitrus.actor("vision.depth_anything.v1", device="gpu-box")
    result = await handle.run("estimate_depth", image_url="https://example.com/frame.png")

    assert result["status"] == "acknowledged"
    assert vitrus.requests[-1]["path"] == "/actors/act_1/commands/estimate_depth"
    assert vitrus.requests[-1]["json"]["input"]["image_url"] == "https://example.com/frame.png"


@pytest.mark.asyncio
async def test_emergency_stop_calls_bridge_endpoint():
    vitrus = FakeBridgeVitrus()
    await vitrus.device(key="r05-edge", name="R-05", kind="robot")

    result = await vitrus.emergency_stop("dev_1", reason="test", source="pytest")

    assert result["result"]["stopped"] is True
    assert vitrus.requests[-1]["path"] == "/devices/dev_1/emergency-stop"
    assert vitrus.requests[-1]["json"] == {"reason": "test", "source": "pytest"}
