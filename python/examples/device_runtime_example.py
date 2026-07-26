import asyncio
import os

from vitrus import Vitrus


async def main():
    vitrus = Vitrus(
        api_key=os.environ["VITRUS_BRIDGE_API_KEY"],
        world=os.environ.get("VITRUS_WORLD_ID", "local-lab"),
        bridge_url=os.environ.get("VITRUS_BRIDGE_URL", "http://127.0.0.1:8788"),
    )

    device = await vitrus.device(
        key="local-compute-device",
        name="Local Compute Device",
        kind="computer",
    )

    actor = device.actor(
        "utility.echo.v1",
        capabilities=["utility.echo"],
    )

    @actor.command("echo")
    async def echo(message: str):
        return {"message": message}

    await device.run_forever()


if __name__ == "__main__":
    asyncio.run(main())
