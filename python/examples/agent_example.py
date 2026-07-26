import asyncio
import os
from vitrus import Vitrus

async def main():
    """Agent example - interacting with an actor"""
    
    # Initialize the Vitrus client
    # Note: A world_id is required and must match the actor's world
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY", "your-api-key-here"),
        world=os.environ.get("VITRUS_WORLD_ID", "your-world-id-here"),
        debug=True  # Enable debug logging
    )
    
    # Get a handle to the actor (without providing metadata)
    # Note: This doesn't create the actor, just gives a handle to interact with an existing one
    actor = await vitrus.actor("python_actor")
    
    # Run a command on the actor
    print(f"Running 'greet' command on actor '{actor.name}'...")
    
    # Run with positional arguments
    result = await actor.run("greet", "Agent", "Nice to meet you!")
    print(f"Result: {result}")
    
    # You can run multiple commands
    print("\nRunning another command...")
    result = await actor.run("greet", "World")
    print(f"Result: {result}")
    
    # Clean up
    print("\nDisconnecting...")

if __name__ == "__main__":
    asyncio.run(main()) 