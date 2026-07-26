import asyncio
import os
from vitrus import Vitrus

async def main():
    """Actor example - creating and using an actor"""
    
    # Initialize the Vitrus client
    # Note: A world_id is required for actor functionality
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY", "your-api-key-here"),
        world=os.environ.get("VITRUS_WORLD_ID", "your-world-id-here"),
        debug=True  # Enable debug logging
    )
    
    # Create an actor with metadata
    actor = await vitrus.actor("python_actor", {
        "type": "example",
        "language": "python",
        "version": "0.1.0"
    })
    
    # Define a command handler
    def greet(name, message=None):
        """Handler for the 'greet' command"""
        if message:
            return f"Hello {name}! Message: {message}"
        else:
            return f"Hello {name}!"
    
    # Register the command handler
    actor.on("greet", greet)
    
    print(f"Actor '{actor.name}' is listening for commands...")
    print("Press Ctrl+C to exit")
    
    # Keep the connection alive
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down actor...")
        actor.disconnect()

if __name__ == "__main__":
    asyncio.run(main()) 