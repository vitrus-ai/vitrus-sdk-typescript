import asyncio
import os
from vitrus import Vitrus

async def main():
    """Simple workflow example"""
    
    # Initialize the Vitrus client
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY", "your-api-key-here"),
        debug=True  # Enable debug logging
    )
    
    # List available workflows
    print("Available workflows:")
    workflows = await vitrus.list_workflows()
    for workflow in workflows:
        print(f"- {workflow['function']['name']}: {workflow['function']['description']}")
    
    # Run the hello-world workflow
    print("\nRunning hello-world workflow...")
    result = await vitrus.workflow("hello-world", {
        "prompt": "Hello from Python SDK!"
    })
    
    print(f"\nWorkflow result: {result}")

if __name__ == "__main__":
    asyncio.run(main()) 