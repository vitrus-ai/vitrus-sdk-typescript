import asyncio
import json
import logging
import os
import uuid
import inspect
from .droid import Droid
from typing import (
    Any,
    Dict,
    List,
    Optional,
    Callable,
    Coroutine,
    Tuple,
    TypeVar,
    Union,
    Mapping,
    Awaitable
)
from enum import Enum

"""
Vitrus SDK (Python).

Client for the Vitrus DAO. Actor/Agent communication with workflow orchestration.

Communication: Dual transport (Zenoh + WebSocket). Handshake over WebSocket obtains clientId
and optional routerUrl. When routerUrl is set, commands/responses and actor broadcasts/events
use Zenoh; the Python client also sends/receives over WebSocket so it works with a WebSocket-only
DAO and with TypeScript actors. actor.on("action", fn) can be invoked via either channel;
responses go back on the same channel. actor.broadcast() sends on both Zenoh and WebSocket when
both are available.
"""

# Using websockets library for Python
import websockets
from websockets.client import WebSocketClientProtocol
from websockets.exceptions import ConnectionClosed, ConnectionClosedError, ConnectionClosedOK

try:
    import zenoh  # type: ignore
    ZENOH_AVAILABLE = True
except Exception:  # pragma: no cover - optional dependency
    ZENOH_AVAILABLE = False

# Setup basic logging
logger = logging.getLogger(__name__)

# --- SDK Version ---
SDK_VERSION = "0.1.0"  # Placeholder, similar to TS fallback
DEFAULT_BASE_URL = "wss://vitrus-dao.onrender.com"
DEFAULT_BRIDGE_URL = "https://vitrus-dataplane.onrender.com"

# --- Message Type Definitions (using TypedDict for clarity) ---
# COMMAND, RESPONSE, ACTOR_BROADCAST, ACTOR_EVENT can come via Zenoh or WebSocket (dual transport).
# In Python, we'd typically use dataclasses or TypedDict for these.
# For simplicity matching the TS interfaces, TypedDict is closer.
try:
    from typing import TypedDict, Literal
except ImportError:
    # For Python < 3.8
    from typing_extensions import TypedDict, Literal


ClientType = Literal['actor', 'agent', 'unknown']

class HandshakeMessage(TypedDict, total=False):
    type: Literal['HANDSHAKE']
    clientType: ClientType
    worldId: Optional[str]
    apiKey: str
    actorName: Optional[str]
    actorId: Optional[str]
    registeredCommands: Optional[List[Dict[str, Any]]]
    metadata: Optional[Any]
    agentName: Optional[str]


class HandshakeResponseMessage(TypedDict):
    type: Literal['HANDSHAKE_RESPONSE']
    success: bool
    clientId: str
    userId: Optional[str]
    error_code: Optional[str]
    message: Optional[str]
    routerUrl: Optional[str]
    actorId: Optional[str]
    serverIp: Optional[str]
    worldExists: Optional[bool]
    actorInfo: Optional[Dict[str, Any]] # Contains metadata and registeredCommands


class CommandMessage(TypedDict):
    type: Literal['COMMAND']
    senderType: ClientType
    senderName: str
    targetType: Union[ClientType, Literal['broadcast']]
    targetName: Optional[str]
    commandName: str
    args: List[Any]
    requestId: str
    sourceChannel: Optional[str]
    worldId: Optional[str]


class ResponseMessage(TypedDict):
    type: Literal['RESPONSE']
    targetChannel: str
    requestId: str
    commandId: str
    result: Optional[Any]
    error: Optional[str]


class RegisterCommandMessage(TypedDict):
    type: Literal['REGISTER_COMMAND']
    actorName: str
    commandName: str
    parameterTypes: List[str]


class WorkflowInvocationMessage(TypedDict):
    type: Literal['WORKFLOW_INVOCATION']
    workflowName: str
    args: Any
    requestId: str


class WorkflowResultMessage(TypedDict):
    type: Literal['WORKFLOW_RESULT']
    requestId: str
    result: Optional[Any]
    error: Optional[str]


class JSONSchema(TypedDict, total=False):
    type: Literal['object', 'string', 'number', 'boolean', 'array']
    description: Optional[str]
    properties: Optional[Dict[str, 'JSONSchema']]
    required: Optional[List[str]]
    items: Optional['JSONSchema']
    additionalProperties: Optional[bool]


class OpenAITool(TypedDict):
    name: str
    description: Optional[str]
    parameters: JSONSchema
    strict: Optional[bool]


class WorkflowDefinition(TypedDict):
    type: Literal['function']
    function: OpenAITool


class ListWorkflowsMessage(TypedDict):
    type: Literal['LIST_WORKFLOWS']
    requestId: str


class WorkflowListMessage(TypedDict):
    type: Literal['WORKFLOW_LIST']
    requestId: str
    workflows: Optional[List[WorkflowDefinition]]
    error: Optional[str]


# --- Get Actor Info (agent requests Supabase-backed actor record) ---
class GetActorInfoMessage(TypedDict):
    type: Literal['GET_ACTOR_INFO']
    worldId: str
    actorName: str
    requestId: str


class ActorRecord(TypedDict, total=False):
    """Supabase-backed actor record (id, info, device_id, state, etc.)."""
    id: str
    name: str
    world_id: str
    info: Any
    device_id: Optional[str]
    state: str
    created_at: str
    updated_at: str
    registeredCommands: Optional[List[Dict[str, Any]]]


class GetActorInfoResponseMessage(TypedDict, total=False):
    type: Literal['GET_ACTOR_INFO_RESPONSE']
    requestId: str
    actor: Optional[ActorRecord]
    error: Optional[str]


# --- Utility for extracting parameter types ---
def get_parameter_types(func: Callable) -> List[str]:
    """
    Extracts parameter type annotations from a function.
    Defaults to 'any' if no annotation is found.
    """
    try:
        sig = inspect.signature(func)
        param_types: List[str] = []
        for param in sig.parameters.values():
            if param.annotation is not inspect.Parameter.empty:
                if hasattr(param.annotation, '__name__'):
                    param_types.append(param.annotation.__name__)
                elif hasattr(param.annotation, '_name') and param.annotation._name: # for things like typing.List
                    param_types.append(str(param.annotation))
                elif hasattr(param.annotation, '__origin__'): # For List[str] etc.
                     param_types.append(str(param.annotation).replace('typing.',''))
                else:
                    param_types.append(str(param.annotation)) 
            else:
                param_types.append('any')
        return param_types
    except (ValueError, TypeError): # inspect.signature can fail on some callables
        try: # Fallback for builtins or weird callables without full signature support
            return ['any'] * len(inspect.getfullargspec(func).args)
        except: # Absolute fallback
             return []


T = TypeVar('T')

# Forward declaration for Vitrus class
class Vitrus:
    pass

# --- Actor Class ---
class Actor:
    _vitrus: "Vitrus"
    _name: str
    _metadata: Dict[str, Any]
    _record: Optional[ActorRecord]
    # Command handlers are stored in Vitrus instance: _vitrus._actor_command_handlers

    def __init__(
        self,
        vitrus_client: "Vitrus",
        name: str,
        metadata: Optional[Dict[str, Any]] = None,
        record: Optional[ActorRecord] = None,
    ):
        self._vitrus = vitrus_client
        self._name = name
        base_meta = metadata if metadata is not None else {}
        if record and record.get("info"):
            self._metadata = {**record.get("info", {}), **base_meta}
        else:
            self._metadata = base_meta
        self._record = record

    def on(self, command_name: str, handler: Callable[..., Awaitable[Any]]):
        """
        Register a command handler for this actor.
        The handler can be a regular function or an async function.
        It will be called with arguments passed from the `run` command.
        """
        parameter_types = get_parameter_types(handler)
        self._vitrus.register_actor_command_handler(self._name, command_name, handler, parameter_types)

        if self._vitrus.is_authenticated and self._vitrus.actor_name == self._name:
            asyncio.create_task(self._vitrus.register_command(self._name, command_name, parameter_types))
        elif self._vitrus.debug:
            logger.info(f"[Vitrus SDK - Actor.on] Queuing REGISTER_COMMAND for {command_name} on {self._name}. Will send after auth.")
        return self

    async def run(self, command_name: str, *args: Any) -> Any:
        """
        Run a command on this actor (implies this instance is an agent-side handle).
        """
        return await self._vitrus.run_command(self._name, command_name, list(args))

    async def broadcast(self, event_name: str, data: Any) -> None:
        """
        Broadcast an event to all agents subscribed to this actor's event (actor-side only).
        Call when connected as this actor.
        """
        await self._vitrus.broadcast_actor_event(self._name, event_name, data)

    def event(self, event_name: str, callback: Callable[[Any], None]) -> "Actor":
        """
        Subscribe to this actor's broadcast events (agent-side). Callback receives event data.
        """
        self._vitrus.subscribe_actor_event(self._name, event_name, callback)
        return self

    def listen(self, event_name: str, callback: Callable[[Any], None]) -> "Actor":
        """
        Alias for event(). Subscribe to this actor's broadcasts (agent-side). e.g. actor.listen('telemetry', lambda data: ...)
        """
        return self.event(event_name, callback)

    @property
    def name(self) -> str:
        return self._name

    @property
    def metadata(self) -> Dict[str, Any]:
        return self._metadata

    @property
    def id(self) -> Optional[str]:
        """Actor ID from Supabase (when fetched via actor(name) as agent)."""
        return self._record.get("id") if self._record else None

    @property
    def info(self) -> Any:
        """Actor info/metadata from Supabase."""
        return (self._record.get("info") if self._record else None) or self._metadata

    @property
    def device_id(self) -> Optional[str]:
        """Associated device ID from Supabase."""
        return self._record.get("device_id") if self._record else None

    @property
    def state(self) -> Optional[str]:
        """Actor state from Supabase (e.g. connected, disconnected)."""
        return self._record.get("state") if self._record else None

    @property
    def registered_commands(
        self,
    ) -> Optional[List[Dict[str, Any]]]:
        """Registered commands from DAO/Supabase."""
        return self._record.get("registeredCommands") if self._record else None

    def update_metadata(self, new_metadata: Dict[str, Any]):
        self._metadata.update(new_metadata)
        if self._vitrus.actor_name == self._name and self._vitrus.is_authenticated:
            # The TS SDK has a TODO for sending metadata update to server. Mirroring that.
            logger.debug(f"Metadata updated for actor {self._name}. Server update not yet implemented in SDK protocol.")


    def disconnect(self) -> None:
        """
        Disconnect the actor if the SDK is currently connected as this actor.
        """
        self._vitrus.disconnect_if_actor(self._name)


# --- Scene Class (Placeholder as in TS) ---
class Scene:
    _vitrus: "Vitrus"
    _scene_id: str

    def __init__(self, vitrus_client: "Vitrus", scene_id: str):
        self._vitrus = vitrus_client
        self._scene_id = scene_id

    def set_structure(self, structure: Any):
        logger.warning("Scene.set_structure is not yet implemented.")

    def add(self, obj: Any):
        logger.warning("Scene.add is not yet implemented.")

    def update(self, params: Dict[str, Any]):
        logger.warning("Scene.update is not yet implemented.")

    def remove(self, object_id: str):
        logger.warning("Scene.remove is not yet implemented.")

    def get(self) -> Dict[str, Any]:
        logger.warning("Scene.get is not yet implemented.")
        return {"id": self._scene_id}


class BridgeActorHandle:
    def __init__(self, vitrus_client: "Vitrus", record: Dict[str, Any]):
        self._vitrus = vitrus_client
        self._record = record

    @property
    def id(self) -> str:
        return self._record["id"]

    @property
    def key(self) -> str:
        return self._record["key"]

    @property
    def name(self) -> str:
        return self.key

    @property
    def capabilities(self) -> List[str]:
        return list(self._record.get("capabilities") or [])

    @property
    def commands(self) -> List[Dict[str, Any]]:
        return list(self._record.get("commands") or [])

    async def run(self, command_name: str, input: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        payload = input if input is not None else kwargs
        return await self._vitrus.run_bridge_actor_command(self.id, command_name, payload)


class ActorRuntime:
    def __init__(
        self,
        device: "DeviceRuntime",
        key: str,
        display_name: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
        events: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.device = device
        self.key = key
        self.display_name = display_name
        self.capabilities = capabilities or []
        self.events = events or []
        self.metadata = metadata or {}
        self.commands: List[Dict[str, Any]] = []
        self.handlers: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self.record: Optional[Dict[str, Any]] = None

    def command(self, name: str, description: Optional[str] = None) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
        def decorator(handler: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
            self.handlers[name] = handler
            self.commands.append(
                {
                    "name": name,
                    "description": description,
                    "parameterTypes": get_parameter_types(handler),
                }
            )
            return handler

        return decorator

    on = command

    async def register(self) -> Dict[str, Any]:
        payload = {
            "device_id": self.device.id,
            "device_key": self.device.key,
            "key": self.key,
            "display_name": self.display_name,
            "world": self.device.world,
            "capabilities": self.capabilities,
            "commands": self.commands,
            "events": self.events,
            "metadata": self.metadata,
        }
        result = await self.device.vitrus._bridge_request("POST", "/actors", json_body=payload)
        self.record = result["actor"]
        return self.record

    async def heartbeat(self) -> None:
        if self.record:
            await self.device.vitrus._bridge_request("POST", f"/actors/{self.record['id']}/heartbeat")


class DeviceRuntime:
    def __init__(self, vitrus_client: "Vitrus", record: Dict[str, Any]):
        self.vitrus = vitrus_client
        self.record = record
        self.actors: List[ActorRuntime] = []
        self._stop_event = asyncio.Event()

    @property
    def id(self) -> str:
        return self.record["id"]

    @property
    def key(self) -> str:
        return self.record["key"]

    @property
    def world(self) -> Optional[str]:
        return self.record.get("world")

    def actor(
        self,
        key: str,
        display_name: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
        events: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ActorRuntime:
        actor = ActorRuntime(self, key, display_name=display_name, capabilities=capabilities, events=events, metadata=metadata)
        self.actors.append(actor)
        return actor

    async def register_actors(self) -> None:
        for actor in self.actors:
            await actor.register()

    async def heartbeat(self) -> None:
        await self.vitrus._bridge_request("POST", f"/devices/{self.id}/heartbeat")
        for actor in self.actors:
            await actor.heartbeat()

    async def run_forever(self, heartbeat_interval: float = 10.0) -> None:
        await self.register_actors()
        while not self._stop_event.is_set():
            await self.heartbeat()
            await asyncio.sleep(heartbeat_interval)

    def stop(self) -> None:
        self._stop_event.set()


# --- Main Vitrus Class ---
class Vitrus:
    """Vitrus client. Connects via WebSocket for handshake (get routerUrl), then uses Zenoh for all agent/actor traffic."""
    _ws: Optional[WebSocketClientProtocol]
    _api_key: str
    _agent_name: Optional[str]
    _world_id: Optional[str]
    _client_id: str
    _is_connected: bool
    _is_authenticated: bool
    _message_handlers: Dict[str, List[Callable[[Dict[str, Any]], None]]]
    _pending_requests: Dict[str, asyncio.Future]
    _actor_command_handlers: Dict[str, Dict[str, Callable[..., Awaitable[Any]]]]
    _actor_command_signatures: Dict[str, Dict[str, List[str]]]
    _actor_metadata: Dict[str, Any]
    _base_url: str
    _debug: bool
    _current_actor_name: Optional[str]
    _connection_lock: asyncio.Lock
    _receive_task: Optional[asyncio.Task]
    _router_url: Optional[str]
    _server_ip: Optional[str]
    _world_exists: Optional[bool]
    _zenoh_session: Optional[Any]
    _zenoh_actor_subscriber: Optional[Any]
    _zenoh_agent_response_subscriber: Optional[Any]
    _zenoh_event_subscribers: Dict[str, Any]  # key "actor_name:event_name" -> subscriber
    _actor_event_listeners: Dict[str, Dict[str, List[Callable[[Any], None]]]]  # actor_name -> event_name -> callbacks
    _main_loop: Optional[asyncio.AbstractEventLoop]  # set when Zenoh session is created (async context); used to schedule work from Zenoh callbacks

    def __init__(
        self,
        api_key: str,
        world: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        bridge_url: Optional[str] = None,
        debug: bool = False,
        agent_name: Optional[str] = None
    ):
        self._api_key = api_key
        self._agent_name = agent_name
        self._world_id = world
        self._base_url = base_url
        self._bridge_url = (bridge_url or os.environ.get("VITRUS_BRIDGE_URL") or DEFAULT_BRIDGE_URL).rstrip("/")
        self._debug = debug

        self._ws = None
        self._client_id = ""
        self._is_connected = False
        self._is_authenticated = False
        self._message_handlers = {}
        self._pending_requests = {}
        self._actor_command_handlers = {}
        self._actor_command_signatures = {}
        self._actor_metadata = {}
        self._current_actor_name = None
        self._connection_lock = asyncio.Lock()
        self._receive_task = None
        self._router_url = None
        self._server_ip = None
        self._world_exists = None
        self._zenoh_session = None
        self._zenoh_actor_subscriber = None
        self._zenoh_agent_response_subscriber = None
        self._zenoh_event_subscribers = {}
        self._actor_event_listeners = {}
        self._main_loop = None
        self._processed_request_ids: set = set()  # dedupe COMMAND by requestId when agent sends to both Zenoh and WS
        self._max_processed_request_ids = 200

        if self._debug:
            # Ensure logger is configured to show INFO level for debug mode
            if not logger.handlers: # Configure only if no handlers are set
                logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            else: # If handlers exist, just set level for this logger
                logger.setLevel(logging.INFO)
            logger.info(f"[Vitrus v{SDK_VERSION}] Initializing with options: api_key=****, agent_name={agent_name}, world={world}, base_url={base_url}, bridge_url={self._bridge_url}, debug={debug}")
        else:
            if not logger.handlers:
                logging.basicConfig(level=logging.WARNING, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            else:
                 logger.setLevel(logging.WARNING)


    async def _connect(self, actor_name_intent: Optional[str] = None, actor_metadata_intent: Optional[Dict[str, Any]] = None) -> None:
        async with self._connection_lock:
            if self._is_connected and self._is_authenticated:
                if actor_name_intent and self._current_actor_name != actor_name_intent:
                    if self._debug: logger.info(f"Re-authenticating as actor: {actor_name_intent}")
                    await self._close_ws_internal()
                elif self._current_actor_name == actor_name_intent:
                    return

            if self._ws:
                 await self._close_ws_internal()

            self._current_actor_name = actor_name_intent or self._current_actor_name
            if self._current_actor_name and actor_metadata_intent:
                self._actor_metadata[self._current_actor_name] = actor_metadata_intent

            params: List[str] = [f"apiKey={self._api_key}"]
            if self._world_id:
                params.append(f"worldId={self._world_id}")

            query_params = f"?{'&'.join(params)}" if params else ""
            full_url = f"{self._base_url}{query_params}"

            if self._debug:
                logger.info(f"[Vitrus] Attempting to connect to WebSocket server: {full_url}")

            try:
                self._ws = await websockets.connect(full_url, ping_interval=20, ping_timeout=20)
                self._is_connected = True
                if self._debug:
                    logger.info("[Vitrus] WebSocket connection established (pre-handshake).")

                self._receive_task = asyncio.create_task(self._receive_loop())

                handshake_msg: HandshakeMessage = {
                    "type": "HANDSHAKE",
                    "clientType": "actor" if self._current_actor_name else "agent",
                    "worldId": self._world_id,
                    "apiKey": self._api_key,
                    "actorName": self._current_actor_name,
                    "registeredCommands": self._get_registered_commands(self._current_actor_name) if self._current_actor_name else None,
                    "metadata": self._actor_metadata.get(self._current_actor_name) if self._current_actor_name else None,
                    "agentName": self._agent_name
                }
                await self._send_message_internal_ws(handshake_msg)

                auth_future = asyncio.Future()
                self._pending_requests["HANDSHAKE_RESPONSE"] = auth_future
                
                try:
                    await asyncio.wait_for(auth_future, timeout=15.0) 
                    self._is_authenticated = auth_future.result() 
                    if not self._is_authenticated:
                         raise ConnectionError(f"Authentication failed: {auth_future.exception() or 'Server rejected handshake'}")
                    if self._debug:
                        logger.info(f"[Vitrus] Authentication successful. Client ID: {self._client_id}, Actor: {self._current_actor_name or 'Agent'}")

                except asyncio.TimeoutError:
                    logger.error("[Vitrus] Authentication timed out.")
                    await self._close_ws_internal(graceful=False)
                    raise ConnectionError("Authentication timed out.")
                except Exception as e:
                    logger.error(f"[Vitrus] Authentication failed during handshake wait: {e}")
                    await self._close_ws_internal(graceful=False)
                    raise ConnectionError(f"Authentication failed: {e}")

            except websockets.exceptions.InvalidURI:
                logger.error(f"[Vitrus] Invalid WebSocket URI: {full_url}")
                self._is_connected = False; self._is_authenticated = False
                raise ConnectionError(f"Invalid WebSocket URI: {full_url}")
            except websockets.exceptions.WebSocketException as e: # Covers handshake errors, connection refused etc.
                logger.error(f"[Vitrus] WebSocket connection failed: {type(e).__name__} - {e}")
                self._is_connected = False; self._is_authenticated = False
                specific_error_msg = str(e)
                if self._world_id:
                    specific_error_msg = f"Connection Failed: Unable to connect to world '{self._world_id}'. This world may not exist, or the API key may be invalid. Original error: {type(e).__name__} - {e}"
                else:
                    specific_error_msg = f"Connection Failed: Unable to establish initial WebSocket connection. Original error: {type(e).__name__} - {e}"
                raise ConnectionError(specific_error_msg)
            except ConnectionError: # Re-raise auth errors from handshake wait
                await self._close_ws_internal(graceful=False)
                raise
            except Exception as e:
                logger.error(f"[Vitrus] An unexpected error occurred during connection: {type(e).__name__} - {e}")
                await self._close_ws_internal(graceful=False)
                self._is_connected = False; self._is_authenticated = False
                raise ConnectionError(f"Unexpected error during connection: {e}")


    async def _close_ws_internal(self, graceful: bool = True):
        """Internal method to close WebSocket and cleanup tasks."""
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                if self._debug: logger.info("[Vitrus] Message receive task cancelled.")
            except Exception as e:
                if self._debug: logger.info(f"[Vitrus] Exception in receive task during its cancellation: {type(e).__name__} - {e}")
        self._receive_task = None

        if self._ws_is_open():
            try:
                if graceful:
                    await self._ws.close()
                else:
                    # For non-graceful close, try different approaches based on websockets version
                    if hasattr(self._ws, 'close_connection'):
                        # Legacy websockets versions - check if it's a coroutine
                        if inspect.iscoroutinefunction(self._ws.close_connection):
                            await self._ws.close_connection()
                        else:
                            self._ws.close_connection()
                    else:
                        # Newer versions - just close normally but don't wait
                        await self._ws.close()
                if self._debug: logger.info("[Vitrus] WebSocket connection closed.")
            except Exception as e:
                if self._debug: logger.warning(f"[Vitrus] Error while closing WebSocket: {type(e).__name__} - {e}")

        if self._zenoh_actor_subscriber:
            try:
                self._zenoh_actor_subscriber.undeclare()
            except Exception:
                pass
            self._zenoh_actor_subscriber = None

        if self._zenoh_agent_response_subscriber:
            try:
                self._zenoh_agent_response_subscriber.undeclare()
            except Exception:
                pass
            self._zenoh_agent_response_subscriber = None

        for sub in self._zenoh_event_subscribers.values():
            try:
                sub.undeclare()
            except Exception:
                pass
        self._zenoh_event_subscribers.clear()

        if self._zenoh_session:
            try:
                self._zenoh_session.close()
            except Exception:
                pass
            self._zenoh_session = None
        
        self._ws = None
        self._is_connected = False
        self._is_authenticated = False 

        disconnect_error = ConnectionError("Connection Lost: The connection to the Vitrus server was closed.")
        for request_id, fut in list(self._pending_requests.items()): # Iterate over a copy
            if not fut.done():
                fut.set_exception(disconnect_error)
            self._pending_requests.pop(request_id, None)


    async def _receive_loop(self):
        if not self._ws: return
        try:
            async for message_str in self._ws:
                if self._debug and isinstance(message_str, str):
                     try:
                        temp_msg = json.loads(message_str)
                        # Avoid logging entire handshake response in debug unless extremely verbose debugging is on
                        if temp_msg.get("type") != "HANDSHAKE_RESPONSE" or logger.getEffectiveLevel() <= logging.DEBUG - 5:
                            logger.info(f"[Vitrus] Raw message received: {message_str}")
                        elif temp_msg.get("type") == "HANDSHAKE_RESPONSE":
                            logger.info(f"[Vitrus] Received HANDSHAKE_RESPONSE (content partially omitted for brevity in standard debug).")
                     except json.JSONDecodeError:
                         logger.info(f"[Vitrus] Raw non-JSON message received: {message_str}")

                try:
                    message = json.loads(message_str)
                    self._handle_message(message)
                except json.JSONDecodeError:
                    logger.error(f"Error parsing WebSocket message as JSON: {message_str[:200]}...") # Log snippet
                except Exception as e: # Catch broad errors in message handling
                    logger.error(f"Error processing message: {type(e).__name__} - {e}. Message snippet: {message_str[:200]}...")
        
        except ConnectionClosedOK:
            if self._debug: logger.info("[Vitrus] WebSocket connection closed normally by server.")
        except ConnectionClosedError as e: # Connection closed with an error code
            logger.error(f"[Vitrus] WebSocket connection closed with error: Code {e.code}, Reason: '{e.reason}'")
        except ConnectionClosed as e: # More general closed connection
            logger.error(f"[Vitrus] WebSocket connection closed unexpectedly: Code {e.code}, Reason: '{e.reason}'")
        except asyncio.CancelledError:
            if self._debug: logger.info("[Vitrus] Receive loop was cancelled.")
            # Do not re-raise, cancellation is part of shutdown
        except Exception as e: # Other unexpected errors in the loop itself
            if self._debug or not isinstance(e, websockets.exceptions.WebSocketException): # Don't be too noisy for common WS closure exceptions if not debugging
                logger.error(f"[Vitrus] Unexpected error in receive loop: {type(e).__name__} - {e}")
        finally:
            if self._debug: logger.info("[Vitrus] Exiting receive loop.")
            # Ensure connection state is updated if loop exits unexpectedly
            if self._is_connected or self._is_authenticated: # If it wasn't an intentional close from our side that already cleaned up
                 await self._close_ws_internal(graceful=False)


    async def _send_message_internal_ws(self, message: Dict[str, Any]):
        if self._ws_is_open():
            msg_str = json.dumps(message)
            if self._debug:
                log_msg = msg_str
                if message.get("type") == "HANDSHAKE": log_msg = "(Handshake message with API key redacted)"
                logger.info(f"[Vitrus] Sending message: {log_msg}")
            await self._ws.send(msg_str)
        else:
            logger.error("[Vitrus] WebSocket not connected or not open. Cannot send message.")
            raise ConnectionError("WebSocket is not connected or not open.")

    async def _send_message_public(self, message: Dict[str, Any]):
        # If not connected, attempt to authenticate.
        # self.authenticate() should robustly attempt connection and authentication.
        # It returns True on success, False on failure, or raises an exception for critical setup issues.
        if not self._is_connected or not self._ws_is_open():
            if self._debug: 
                logger.info("[Vitrus] _send_message_public: Not connected. Attempting to authenticate.")
            
            auth_successful = await self.authenticate() # authenticate() will try to connect.
            
            if not auth_successful:
                # If authenticate() explicitly returns False, it means it tried and determined a failure
                # (e.g., handshake failed but connection didn't immediately drop, or API key invalid).
                # The state (_is_connected, _is_authenticated) should reflect this.
                logger.error("[Vitrus] _send_message_public: Authentication attempt returned False. Cannot send message.")
                raise ConnectionError("Failed to authenticate or establish a viable connection.")
            
            # If auth_successful is True, then self.authenticate() believes it has succeeded.
            # self._is_connected and self._is_authenticated should be True.
            # We still need to check the actual WebSocket state immediately before sending,
            # as a rapid disconnection could have occurred.

        # Final check: even if authentication was successful (or thought to be),
        # is the WebSocket genuinely open RIGHT NOW?
        if not self._is_connected or not self._ws_is_open():
            # This path means:
            # 1. We were initially connected, but it dropped before this check.
            # 2. We attempted re-authentication, it *claimed* success (returned True),
            #    but the connection is already gone (e.g., _receive_loop died and reset flags).
            # This is the scenario matching the user's error, pointing to an unstable connection
            # or a race where the connection drops right after the handshake.
            logger.warning("[Vitrus] _send_message_public: Connection found to be closed immediately before sending, "
                           "despite prior checks or authentication attempts. This may indicate an unstable connection or immediate post-handshake closure.")
            raise ConnectionError(
                "Connection is not active. It may have been lost immediately after being established or during an authentication attempt."
            )

        # If all checks pass, attempt to send.
        try:
            await self._send_message_internal_ws(message)
        except ConnectionError as e: # Catch specific ConnectionError from _send_message_internal_ws
            logger.error(f"[Vitrus] _send_message_public: Connection error during the actual send operation: {e}")
            # It's possible the connection dropped at the exact moment of sending.
            # Ensure state is fully reset if this happens.
            if self._is_connected or self._is_authenticated: # Avoid redundant call if already closing
                await self._close_ws_internal(graceful=False) # Reset state
            raise # Re-raise the ConnectionError from _send_message_internal_ws
        except Exception as e:
            logger.error(f"[Vitrus] _send_message_public: Unexpected error during send: {type(e).__name__} - {e}")
            if self._is_connected or self._is_authenticated: # Avoid redundant call if already closing
                await self._close_ws_internal(graceful=False) # Reset state
            raise # Re-raise as a generic error or wrap it


    async def _ensure_zenoh_session(self) -> bool:
        if not ZENOH_AVAILABLE or not self._router_url:
            return False
        if self._zenoh_session:
            return True
        try:
            config = zenoh.Config()
            try:
                config.insert_json5("connect/endpoints", f'["{self._router_url}"]')
            except Exception:
                pass
            # zenoh.open() is blocking; run in executor to avoid blocking the asyncio event loop
            loop = asyncio.get_running_loop()
            self._main_loop = loop
            self._zenoh_session = await loop.run_in_executor(None, zenoh.open, config)
            if self._debug:
                logger.info("[Vitrus] Connected to Zenoh router at %s - agent/actor traffic will use Zenoh.", self._router_url)
            self._ensure_zenoh_agent_response_subscriber()
            return True
        except Exception as e:
            if self._debug:
                logger.info(f"[Vitrus] Failed to establish Zenoh session: {e}")
            self._zenoh_session = None
            return False

    def _ensure_zenoh_agent_response_subscriber(self) -> None:
        if not self._zenoh_session or self._zenoh_agent_response_subscriber or not self._client_id:
            return
        agent_channel = self._get_agent_channel()
        if not agent_channel:
            return
        main_loop = self._main_loop

        def _on_sample(sample: Any) -> None:
            message = self._parse_zenoh_sample(sample)
            if not message or message.get("type") != "RESPONSE":
                return
            request_id = message.get("requestId")
            fut = self._pending_requests.pop(request_id, None)
            if not fut or fut.done():
                return
            err = message.get("error")
            result = message.get("result")
            # Zenoh invokes this from a worker thread; schedule result on main loop so the awaiting coroutine wakes immediately
            if main_loop:
                main_loop.call_soon_threadsafe(
                    lambda: _resolve_response_future(fut, err, result)
                )
            else:
                if err:
                    fut.set_exception(RuntimeError(err))
                else:
                    fut.set_result(result)

        def _resolve_response_future(f: asyncio.Future, err: Optional[str], result: Any) -> None:
            if f.done():
                return
            if err:
                f.set_exception(RuntimeError(err))
            else:
                f.set_result(result)

        try:
            self._zenoh_agent_response_subscriber = self._zenoh_session.declare_subscriber(
                agent_channel, _on_sample
            )
            if self._debug:
                logger.info("[Vitrus] Subscribed to agent response channel via Zenoh: %s", agent_channel)
        except Exception as e:
            if self._debug:
                logger.info("[Vitrus] Failed to declare Zenoh agent response subscriber: %s", e)

    async def _ensure_zenoh_actor_subscriber(self) -> None:
        if not self._current_actor_name:
            return
        if not await self._ensure_zenoh_session():
            return
        if self._zenoh_actor_subscriber:
            return
        actor_key = self._get_actor_key(self._current_actor_name)

        def _on_sample(sample: Any):
            message = self._parse_zenoh_sample(sample)
            if not message or message.get("type") != "COMMAND":
                return
            self._handle_command_message(message)

        try:
            self._zenoh_actor_subscriber = self._zenoh_session.declare_subscriber(actor_key, _on_sample)
        except Exception as e:
            if self._debug:
                logger.info(f"[Vitrus] Failed to declare Zenoh subscriber: {e}")
            self._zenoh_actor_subscriber = None

    def _parse_zenoh_sample(self, sample: Any) -> Optional[Dict[str, Any]]:
        payload = getattr(sample, "payload", sample)
        if hasattr(payload, "to_string"):
            text = payload.to_string()
        elif isinstance(payload, (bytes, bytearray)):
            text = payload.decode("utf-8", errors="ignore")
        else:
            text = str(payload)
        try:
            return json.loads(text)
        except Exception:
            return None

    def _publish_zenoh(self, key_expr: str, message: Dict[str, Any]) -> None:
        if not self._zenoh_session:
            return
        self._zenoh_session.put(key_expr, json.dumps(message))

    def _handle_message(self, message: Dict[str, Any]):
        msg_type = message.get("type")
        
        # More selective logging for HANDSHAKE_RESPONSE
        if msg_type == "HANDSHAKE_RESPONSE":
            if self._debug: logger.info(f"[Vitrus] Handling HANDSHAKE_RESPONSE.")
        elif self._debug:
             logger.info(f"[Vitrus] Handling message of type: {msg_type}, RequestID: {message.get('requestId')}")


        if msg_type == "HANDSHAKE_RESPONSE":
            response = message # No need to cast to TypedDict for internal handling if careful
            auth_future = self._pending_requests.pop("HANDSHAKE_RESPONSE", None)
            if response.get("success"):
                self._client_id = response.get("clientId", "")
                self._router_url = response.get("routerUrl") or self._router_url
                self._server_ip = response.get("serverIp")
                self._world_exists = response.get("worldExists")
                if self._router_url and self._debug:
                    logger.info("[Vitrus] Agent/actor communication: Zenoh (routerUrl=%s)", self._router_url)
                elif not self._router_url and self._debug:
                    logger.info("[Vitrus] Agent/actor communication: WebSocket only (no Zenoh routerUrl).")
                if self._debug: logger.info(f"[Vitrus] Handshake successful. Client ID: {self._client_id}.")
                if self._current_actor_name and self._router_url:
                    asyncio.create_task(self._ensure_zenoh_actor_subscriber())
                
                actor_info = response.get("actorInfo")
                if actor_info and self._current_actor_name:
                    self._actor_metadata[self._current_actor_name] = actor_info.get("metadata", {})
                    registered_cmds = actor_info.get("registeredCommands", [])
                    if registered_cmds:
                        if self._current_actor_name not in self._actor_command_signatures:
                            self._actor_command_signatures[self._current_actor_name] = {}
                        for cmd_def in registered_cmds: # cmd_def is dict like {"name": "cmd_name", "parameterTypes": []}
                            self._actor_command_signatures[self._current_actor_name][cmd_def["name"]] = cmd_def["parameterTypes"]
                
                if auth_future and not auth_future.done(): auth_future.set_result(True)
                # If we're an agent, sync event subscriptions to DAO over WebSocket so we receive broadcasts from WS actors
                if not self._current_actor_name:
                    asyncio.create_task(self._sync_agent_event_subscriptions_ws())
            else:
                err_msg = response.get("message", "Handshake failed due to unknown server error.")
                err_code = response.get("error_code", "UNKNOWN_ERROR")
                logger.error(f"Handshake failed: {err_msg} (Error code: {err_code})")
                if auth_future and not auth_future.done(): auth_future.set_exception(ConnectionError(f"Authentication failed: {err_msg} (Code: {err_code})"))
            return

        request_id = message.get("requestId")
        pending_future = self._pending_requests.get(request_id) if request_id else None

        # Handle get actor info response (Supabase-backed actor record)
        if msg_type == "GET_ACTOR_INFO_RESPONSE":
            rid = message.get("requestId")
            pending = self._pending_requests.get(rid) if rid else None
            if pending:
                self._pending_requests.pop(rid)
                err = message.get("error")
                if err:
                    if not pending.done():
                        pending.set_exception(RuntimeError(err))
                else:
                    actor_data = message.get("actor")
                    if not pending.done():
                        pending.set_result(actor_data)
            return

        # COMMAND and RESPONSE come via Zenoh only; not handled on WebSocket.

        if msg_type in ["RESPONSE", "WORKFLOW_RESULT", "WORKFLOW_LIST"]:
            if pending_future:
                self._pending_requests.pop(request_id) # Remove once we attempt to resolve
                error = message.get("error")
                if error:
                    if self._debug: logger.info(f"[Vitrus] Received error for {request_id}: {error}")
                    if not pending_future.done(): pending_future.set_exception(RuntimeError(error))
                else:
                    result_data = None
                    if msg_type == "RESPONSE": result_data = message.get("result")
                    elif msg_type == "WORKFLOW_RESULT": result_data = message.get("result")
                    elif msg_type == "WORKFLOW_LIST": result_data = message.get("workflows", [])
                    
                    if self._debug: logger.info(f"[Vitrus] Received result for {request_id}: {str(result_data)[:100]}...")
                    if not pending_future.done(): pending_future.set_result(result_data)
            elif request_id:
                logger.warning(f"Received message for unknown or already handled request ID: {request_id}, Type: {msg_type}")
            return

        # COMMAND can come via WebSocket when DAO does not use Zenoh (routerUrl not set)
        if msg_type == "COMMAND":
            self._handle_command_message(message)
            return

        # ACTOR_BROADCAST / ACTOR_EVENT can come via WebSocket (DAO forwarding to agent) or Zenoh
        if msg_type in ("ACTOR_BROADCAST", "ACTOR_EVENT"):
            actor_name = message.get("actorName")
            event_name = message.get("eventName") or message.get("broadcastName")
            data = message.get("args", {})
            if actor_name and event_name:
                callbacks = self._actor_event_listeners.get(actor_name, {}).get(event_name, [])
                for cb in callbacks:
                    try:
                        cb(data)
                    except Exception as e:
                        if self._debug:
                            logger.info("[Vitrus] Actor event callback error: %s", e)
            return

        handlers = self._message_handlers.get(msg_type, [])
        for handler_fn in handlers:
            try: handler_fn(message)
            except Exception as e: logger.error(f"Error in custom message handler for type {msg_type}: {e}")

    def _handle_command_message(self, command_msg_data: Dict[str,Any]):
        target_type = command_msg_data.get("targetType")
        target_name = command_msg_data.get("targetName")
        actor_name = target_name if target_type == "actor" else self._current_actor_name
        if not actor_name:
            actor_name = command_msg_data.get("targetActorName")
        command_name = command_msg_data.get("commandName")
        args = command_msg_data.get("args", [])
        request_id = command_msg_data.get("requestId")
        source_channel = command_msg_data.get("sourceChannel")

        if not all([actor_name, command_name, request_id]): # source_channel is optional
            logger.error(f"Received malformed COMMAND message: {command_msg_data}")
            return

        # Dedupe: Python agent sends to both Zenoh and DAO WebSocket; actor may receive same COMMAND twice
        if request_id in self._processed_request_ids:
            if self._debug: logger.debug(f"[Vitrus] Skipping duplicate COMMAND requestId={request_id}")
            return
        if len(self._processed_request_ids) >= self._max_processed_request_ids:
            self._processed_request_ids.clear()
        self._processed_request_ids.add(request_id)

        if self._debug: logger.info(f"[Vitrus] Handling command: '{command_name}' for actor '{actor_name}' with args: {args}")

        actor_handlers = self._actor_command_handlers.get(actor_name, {})
        handler = actor_handlers.get(command_name)

        async def execute_and_respond_task():
            response_payload: Dict[str, Any] = {
                "type": "RESPONSE",
                "targetChannel": source_channel or "",
                "requestId": request_id,
                "commandId": request_id
            }
            if not handler:
                logger.warning(f"No handler for command '{command_name}' on actor '{actor_name}'.")
                response_payload["error"] = f"Command '{command_name}' not found on actor '{actor_name}'."
            else:
                try:
                    if inspect.iscoroutinefunction(handler): result = await handler(*args)
                    else: # Run sync handler in thread pool executor
                        loop = asyncio.get_running_loop()
                        result = await loop.run_in_executor(None, handler, *args)
                    if self._debug: logger.info(f"Command '{command_name}' on '{actor_name}' executed. Result: {str(result)[:100]}...")
                    response_payload["result"] = result
                except Exception as e:
                    logger.error(f"Error executing command '{command_name}' on '{actor_name}': {type(e).__name__} - {e}", exc_info=self._debug)
                    response_payload["error"] = str(e)
            
            try:  # Respond via same channel: Zenoh if command had sourceChannel (from Zenoh), else WebSocket (from DAO/TS agent)
                if source_channel and self._router_url and await self._ensure_zenoh_session() and self._zenoh_session:
                    reply_key = source_channel
                    self._publish_zenoh(reply_key, response_payload)
                else:
                    await self._send_message_internal_ws(response_payload)
            except ConnectionError as ce:
                logger.error(f"ConnectionError sending response for {request_id}: {ce}")
            except Exception as e:
                logger.error(f"Unexpected error sending response for {request_id}: {e}")

        # Zenoh invokes this from a worker thread; schedule the coroutine on the main loop
        if self._main_loop is not None:
            asyncio.run_coroutine_threadsafe(execute_and_respond_task(), self._main_loop)
        else:
            asyncio.create_task(execute_and_respond_task())


    def _generate_request_id(self) -> str:
        return uuid.uuid4().hex[:13]

    def _get_actor_key(self, actor_name: str) -> str:
        if not self._world_id:
            if self._debug:
                logger.info("[Vitrus] No world_id set, using actor name for key.")
            return f"dao/actor/{actor_name}"
        return f"dao/{self._world_id}/actor/{actor_name}"

    def _get_actor_event_key(self, actor_name: str, event_name: str) -> str:
        if not self._world_id:
            return f"dao/actor/{actor_name}/event/{event_name}"
        return f"dao/{self._world_id}/actor/{actor_name}/event/{event_name}"

    def _get_agent_channel(self) -> Optional[str]:
        if not self._client_id:
            return None
        return f"dao/agent/{self._client_id}"

    def _get_agent_sender_name(self) -> str:
        return self._client_id or "agent"

    async def broadcast_actor_event(self, actor_name: str, event_name: str, data: Any) -> None:
        """Actor broadcasts an event to subscribed agents on both Zenoh and WebSocket when available."""
        if not self._is_authenticated or self._current_actor_name != actor_name:
            raise RuntimeError("Must be authenticated as this actor to broadcast")
        payload = {"type": "ACTOR_BROADCAST", "actorName": actor_name, "eventName": event_name, "args": data if data is not None else {}, "worldId": self._world_id}
        # Send via Zenoh when router is configured
        if self._router_url and await self._ensure_zenoh_session() and self._zenoh_session:
            self._zenoh_session.put(self._get_actor_event_key(actor_name, event_name), json.dumps(payload))
            if self._debug:
                logger.info("[Vitrus] Broadcast via Zenoh (event=%s)", event_name)
        # Also send via WebSocket so DAO can forward to WS-connected agents
        if self._ws_is_open():
            await self._send_message_internal_ws(payload)
            if self._debug:
                logger.info("[Vitrus] Broadcast via WebSocket (event=%s)", event_name)

    def subscribe_actor_event(self, actor_name: str, event_name: str, callback: Callable[[Any], None]) -> None:
        """Agent subscribes to an actor's event (Zenoh and/or WebSocket). Registers callback and notifies DAO over WS when agent."""
        if actor_name not in self._actor_event_listeners:
            self._actor_event_listeners[actor_name] = {}
        if event_name not in self._actor_event_listeners[actor_name]:
            self._actor_event_listeners[actor_name][event_name] = []
        self._actor_event_listeners[actor_name][event_name].append(callback)

        async def _ensure_zenoh_event_sub() -> None:
            if await self._ensure_zenoh_session():
                self._ensure_zenoh_event_subscriber(actor_name, event_name)

        asyncio.create_task(_ensure_zenoh_event_sub())

        # Register with DAO over WebSocket so we receive broadcasts from WS actors (and Zenoh actors forwarded by DAO)
        async def _send_subscribe_ws() -> None:
            if self._is_authenticated and self._ws_is_open() and not self._current_actor_name:
                try:
                    await self._send_message_internal_ws({"type": "SUBSCRIBE_ACTOR_EVENT", "actorName": actor_name, "eventName": event_name})
                    if self._debug:
                        logger.info("[Vitrus] SUBSCRIBE_ACTOR_EVENT sent over WebSocket: %s / %s", actor_name, event_name)
                except Exception as e:
                    if self._debug:
                        logger.info("[Vitrus] Failed to send SUBSCRIBE_ACTOR_EVENT over WS: %s", e)

        asyncio.create_task(_send_subscribe_ws())

    async def _sync_agent_event_subscriptions_ws(self) -> None:
        """Send SUBSCRIBE_ACTOR_EVENT for all registered event listeners so DAO forwards broadcasts to this agent."""
        if not self._is_authenticated or not self._ws_is_open() or self._current_actor_name:
            return
        for actor_name, events in self._actor_event_listeners.items():
            for event_name in events:
                try:
                    await self._send_message_internal_ws({"type": "SUBSCRIBE_ACTOR_EVENT", "actorName": actor_name, "eventName": event_name})
                    if self._debug:
                        logger.info("[Vitrus] SUBSCRIBE_ACTOR_EVENT (sync) over WebSocket: %s / %s", actor_name, event_name)
                except Exception as e:
                    if self._debug:
                        logger.info("[Vitrus] Failed to sync SUBSCRIBE_ACTOR_EVENT over WS: %s", e)

    def _ensure_zenoh_event_subscriber(self, actor_name: str, event_name: str) -> None:
        if not self._zenoh_session:
            return
        key = f"{actor_name}:{event_name}"
        if key in self._zenoh_event_subscribers:
            return
        event_key = self._get_actor_event_key(actor_name, event_name)

        def _on_sample(sample: Any) -> None:
            message = self._parse_zenoh_sample(sample)
            if not message or message.get("type") not in ("ACTOR_BROADCAST", "ACTOR_EVENT"):
                return
            data = message.get("args", {})
            callbacks = self._actor_event_listeners.get(actor_name, {}).get(event_name, [])
            for cb in callbacks:
                try:
                    cb(data)
                except Exception as e:
                    if self._debug:
                        logger.info("[Vitrus] Actor event callback error: %s", e)

        try:
            sub = self._zenoh_session.declare_subscriber(event_key, _on_sample)
            self._zenoh_event_subscribers[key] = sub
            if self._debug:
                logger.info("[Vitrus] Subscribed to actor event via Zenoh: %s", event_key)
        except Exception as e:
            if self._debug:
                logger.info("[Vitrus] Failed to declare Zenoh event subscriber: %s", e)

    async def authenticate(self, actor_name: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> bool:
        if self._debug: logger.info(f"[Vitrus] Authenticating..." + (f" (as actor: {actor_name})" if actor_name else " (as agent)"))

        if actor_name and not self._world_id:
            raise ValueError("Vitrus SDK requires a world_id to authenticate as an actor.")

        if self._is_authenticated and actor_name == self._current_actor_name:
            if self._debug: logger.info(f"Already authenticated as {actor_name or 'agent'}.")
            return True
        
        # If switching actor or initial auth, (re)connect
        self._current_actor_name = actor_name # Set intent
        if actor_name and metadata: self._actor_metadata[actor_name] = metadata
        
        try:
            await self._connect(actor_name_intent=actor_name, actor_metadata_intent=metadata)
            if self._is_authenticated and self._current_actor_name: # Successfully authenticated as specific actor
                await self._register_pending_commands(self._current_actor_name)
        except ConnectionError as e: # Covers connection and auth failures from _connect
            logger.error(f"[Vitrus] Authentication failed: {e}")
            # _connect should have reset state, but ensure here too
            self._is_authenticated = False; self._is_connected = False
            self._current_actor_name = None 
            return False
        except Exception as e: # Other unexpected errors
            logger.error(f"[Vitrus] Unexpected error during authentication process: {type(e).__name__} - {e}")
            await self._close_ws_internal(graceful=False) # Ensure WS is down
            return False

        return self._is_authenticated


    def register_actor_command_handler(
        self, actor_name: str, command_name: str,
        handler: Callable[..., Awaitable[Any]], parameter_types: List[str]
    ):
        if self._debug: logger.info(f"[Vitrus] Registering local command handler for actor '{actor_name}', command '{command_name}'")
        
        if actor_name not in self._actor_command_handlers: self._actor_command_handlers[actor_name] = {}
        self._actor_command_handlers[actor_name][command_name] = handler

        if actor_name not in self._actor_command_signatures: self._actor_command_signatures[actor_name] = {}
        self._actor_command_signatures[actor_name][command_name] = parameter_types


    async def register_command(self, actor_name: str, command_name: str, parameter_types: List[str]):
        if not self._is_authenticated or self._current_actor_name != actor_name:
            if self._debug: logger.info(f"[Vitrus] Queuing server registration for command '{command_name}' on actor '{actor_name}'. Will send after full auth as this actor.")
            return # Will be handled by _register_pending_commands

        if self._debug: logger.info(f"[Vitrus] Registering command with server: actor='{actor_name}', command='{command_name}'")
        message: RegisterCommandMessage = {"type": "REGISTER_COMMAND", "actorName": actor_name, "commandName": command_name, "parameterTypes": parameter_types}
        await self._send_message_public(message)

    def _get_registered_commands(self, actor_name: Optional[str]) -> Optional[List[Dict[str, Any]]]:
        if not actor_name:
            return None
        signatures = self._actor_command_signatures.get(actor_name, {})
        return [{"name": name, "parameterTypes": parameter_types} for name, parameter_types in signatures.items()]


    async def _register_pending_commands(self, actor_name: str):
        if not self._is_authenticated or self._current_actor_name != actor_name: return
        if self._debug: logger.info(f"[Vitrus] Registering any pending commands for actor '{actor_name}' with the server.")
        
        signatures = self._actor_command_signatures.get(actor_name, {})
        handlers = self._actor_command_handlers.get(actor_name,{})

        for cmd_name, param_types in signatures.items():
            if cmd_name in handlers:
                try:
                    if self._debug: logger.info(f"Sending actual REGISTER_COMMAND for {actor_name}.{cmd_name}")
                    # This call to register_command will now pass the auth check
                    await self.register_command(actor_name, cmd_name, param_types)
                except Exception as e: logger.error(f"Error registering pending command {cmd_name} for actor {actor_name}: {e}")


    async def get_actor_info(self, actor_name: str) -> Optional[ActorRecord]:
        """Fetch Supabase-backed actor record (id, info, device_id, state, registeredCommands)."""
        if not self._world_id:
            raise ValueError("Vitrus SDK requires a world_id to get actor info.")
        if not self._is_authenticated:
            await self.authenticate()
        request_id = self._generate_request_id()
        msg: GetActorInfoMessage = {
            "type": "GET_ACTOR_INFO",
            "worldId": self._world_id,
            "actorName": actor_name,
            "requestId": request_id,
        }
        fut: asyncio.Future[Optional[ActorRecord]] = asyncio.Future()
        self._pending_requests[request_id] = fut
        try:
            await self._send_message_public(msg)
            return await asyncio.wait_for(fut, timeout=10.0)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            logger.warning(f"Timeout waiting for GET_ACTOR_INFO for '{actor_name}' (req ID: {request_id})")
            return None
        except Exception:
            self._pending_requests.pop(request_id, None)
            raise

    async def device(
        self,
        key: str,
        name: Optional[str] = None,
        kind: str = "generic",
        metadata: Optional[Dict[str, Any]] = None,
        runtime: Optional[Dict[str, Any]] = None,
        network: Optional[Dict[str, Any]] = None,
    ) -> DeviceRuntime:
        payload = {
            "key": key,
            "name": name or key,
            "kind": kind,
            "world": self._world_id,
            "metadata": metadata or {},
            "runtime": runtime or {},
            "network": network or {},
        }
        result = await self._bridge_request("POST", "/devices", json_body=payload)
        return DeviceRuntime(self, result["device"])

    async def list_devices(self, online: bool = False) -> List[Dict[str, Any]]:
        params = {"online": str(online).lower()}
        if self._world_id:
            params["world"] = self._world_id
        result = await self._bridge_request("GET", "/devices", params=params)
        return result.get("devices", [])

    async def list_actors(self, device_id: Optional[str] = None) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if self._world_id:
            params["world"] = self._world_id
        if device_id:
            params["device_id"] = device_id
        result = await self._bridge_request("GET", "/actors", params=params)
        return result.get("actors", [])

    async def run_bridge_actor_command(self, actor_id: str, command_name: str, input: Optional[Dict[str, Any]] = None) -> Any:
        return await self._bridge_request("POST", f"/actors/{actor_id}/commands/{command_name}", json_body={"input": input or {}})

    async def emergency_stop(self, device_id: str, reason: str = "unknown", source: str = "python_sdk") -> Any:
        return await self._bridge_request("POST", f"/devices/{device_id}/emergency-stop", json_body={"reason": reason, "source": source})

    async def _bridge_request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        import httpx

        headers = {"authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(method, f"{self._bridge_url}{path}", headers=headers, json=json_body, params=params)
            response.raise_for_status()
            if response.content:
                return response.json()
            return {}

    async def actor(self, name: str, options: Optional[Dict[str, Any]] = None, *, device: Optional[str] = None) -> Union[Actor, BridgeActorHandle]:
        if device is not None:
            devices = await self.list_devices(online=False)
            matching_device = next((item for item in devices if item.get("key") == device or item.get("id") == device), None)
            if not matching_device:
                raise RuntimeError(f"Device {device!r} not found in Vitrus Bridge registry.")
            actors = await self.list_actors(device_id=matching_device["id"])
            matching_actor = next((item for item in actors if item.get("key") == name or item.get("id") == name), None)
            if not matching_actor:
                raise RuntimeError(f"Actor {name!r} not found on device {device!r}.")
            return BridgeActorHandle(self, matching_actor)

        if self._debug: logger.info(f"[Vitrus] actor(name='{name}', options={'provided' if options is not None else 'not provided'})")

        if options is not None and not self._world_id:
            raise ValueError("Vitrus SDK requires a world_id to create/authenticate as an actor with options.")

        current_meta = self._actor_metadata.get(name, {})
        if options is not None: current_meta.update(options); self._actor_metadata[name] = current_meta

        record: Optional[ActorRecord] = None
        if options is None and self._world_id:
            record = await self.get_actor_info(name)
            # Agent: ensure Zenoh session and response subscriber are ready before first run_command
            await self._ensure_zenoh_session()
        actor_instance = Actor(self, name, current_meta, record=record)

        if options is not None: # Intent to BE this actor
            # Authenticate if not already this actor, or if metadata changed implying re-auth might be needed
            if not self._is_authenticated or self._current_actor_name != name:
                 if self._debug: logger.info(f"[Vitrus] Options provided for actor '{name}'. Ensuring authentication as this actor...")
                 await self.authenticate(name, self._actor_metadata.get(name)) # This will also call _register_pending_commands on success
            else: # Already authenticated as this actor
                 if self._debug: logger.info(f"Already authenticated as actor '{name}'. Ensuring commands are registered.")
                 await self._register_pending_commands(name) # Ensure commands are up-to-date
        return actor_instance


    def scene(self, scene_id: str) -> Scene:
        if self._debug: logger.info(f"[Vitrus] Getting scene handle for ID: {scene_id}")
        return Scene(self, scene_id)


    async def run_command(self, actor_name: str, command_name: str, args: List[Any]) -> Any:
        if self._debug: logger.info(f"[Vitrus] run_command: actor='{actor_name}', command='{command_name}', args={args}")
        if not self._world_id: raise ValueError("Vitrus SDK requires a world_id to run commands on actors.")
        if not self._is_authenticated: await self.authenticate()  # Authenticate as agent

        request_id = self._generate_request_id()
        command_msg: CommandMessage = {
            "type": "COMMAND",
            "senderType": "agent",
            "senderName": self._get_agent_sender_name(),
            "targetType": "actor",
            "targetName": actor_name,
            "commandName": command_name,
            "args": args,
            "requestId": request_id,
            "sourceChannel": self._get_agent_channel(),
            "worldId": self._world_id
        }

        fut = asyncio.Future()
        self._pending_requests[request_id] = fut
        try:
            # Send via Zenoh so Python actors receive (when routerUrl is set)
            if self._router_url:
                await self._ensure_zenoh_session()
                if self._zenoh_session:
                    actor_key = self._get_actor_key(actor_name)
                    self._publish_zenoh(actor_key, command_msg)
                    if self._debug: logger.info("[Vitrus] Command sent via Zenoh (actor=%s)", actor_name)
            # Always send via DAO WebSocket so TypeScript actors receive (DAO forwards to WS actors)
            if self._ws_is_open():
                await self._send_message_internal_ws(command_msg)
                if self._debug: logger.info("[Vitrus] Command sent via DAO WebSocket (actor=%s)", actor_name)
            return await asyncio.wait_for(fut, timeout=30.0)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            logger.error(f"Timeout waiting for response to command '{command_name}' on actor '{actor_name}' (req ID: {request_id})")
            raise TimeoutError(f"Timeout for command '{command_name}' on '{actor_name}'")
        except Exception:
            self._pending_requests.pop(request_id, None)
            raise


    async def workflow(self, workflow_name: str, args: Optional[Dict[str, Any]] = None) -> Any:
        if self._debug: logger.info(f"[Vitrus] Running workflow: '{workflow_name}' with args: {args}")
        # Preserve existing authentication state - don't force re-auth as agent
        if not self._is_authenticated: 
            # If we have a current actor name, re-authenticate as that actor
            if self._current_actor_name:
                await self.authenticate(self._current_actor_name, self._actor_metadata.get(self._current_actor_name))
            else:
                await self.authenticate()  # Authenticate as agent only if no actor context

        request_id = self._generate_request_id()
        workflow_msg: WorkflowInvocationMessage = {"type": "WORKFLOW_INVOCATION", "workflowName": workflow_name, "args": args if args is not None else {}, "requestId": request_id}

        fut = asyncio.Future()
        self._pending_requests[request_id] = fut
        try:
            await self._send_message_public(workflow_msg)
            return await asyncio.wait_for(fut, timeout=300.0) # 5 min timeout for workflow
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            logger.error(f"Timeout waiting for result of workflow '{workflow_name}' (req ID: {request_id})")
            raise TimeoutError(f"Timeout for workflow '{workflow_name}'")
        except Exception as e:
            self._pending_requests.pop(request_id, None)
            raise

    async def list_workflows(self) -> List[WorkflowDefinition]:
        if self._debug: logger.info("[Vitrus] Requesting list of available workflows.")
        # Preserve existing authentication state - don't force re-auth as agent
        if not self._is_authenticated:
            # If we have a current actor name, re-authenticate as that actor
            if self._current_actor_name:
                await self.authenticate(self._current_actor_name, self._actor_metadata.get(self._current_actor_name))
            else:
                await self.authenticate()  # Authenticate as agent only if no actor context

        request_id = self._generate_request_id()
        list_msg: ListWorkflowsMessage = {"type": "LIST_WORKFLOWS", "requestId": request_id}

        fut = asyncio.Future()
        self._pending_requests[request_id] = fut
        try:
            await self._send_message_public(list_msg)
            return await asyncio.wait_for(fut, timeout=30.0)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            logger.error(f"Timeout waiting for workflow list (req ID: {request_id})")
            raise TimeoutError("Timeout waiting for workflow list")
        except Exception as e:
            self._pending_requests.pop(request_id, None)
            raise

    async def upload_image(self, image_data: bytes, filename: str = "image.png") -> str:
        if self._debug: logger.info(f"[Vitrus] Mock uploading image: {filename} (size: {len(image_data)} bytes)")
        logger.warning("Vitrus.upload_image is a mock implementation.")
        return f"https://vitrus.io/images/{filename}" # Mock URL

    async def add_record(self, data: Dict[str, Any], name: Optional[str] = None) -> str:
        if self._debug: logger.info(f"[Vitrus] Mock adding record: {name or 'untitled'} with data: {data}")
        logger.warning("Vitrus.add_record is a mock implementation.")
        return name or self._generate_request_id()

    @property
    def is_authenticated(self) -> bool: return self._is_authenticated
    @property
    def actor_name(self) -> Optional[str]: return self._current_actor_name
    @property
    def client_id(self) -> str: return self._client_id
    @property
    def debug(self) -> bool: return self._debug

    def disconnect_if_actor(self, actor_name_to_disconnect: str) -> None:
        if self._current_actor_name == actor_name_to_disconnect and self._is_authenticated:
            if self._ws_is_open():
                if self._debug: logger.info(f"[Vitrus] Actor '{actor_name_to_disconnect}' is requesting SDK disconnect.")
                asyncio.create_task(self._close_ws_internal(graceful=True)) # Schedule close
            else: # Authenticated as actor, but WS not open.
                 if self._debug: logger.info(f"[Vitrus] disconnect_if_actor: WS for '{actor_name_to_disconnect}' not open, but was auth'd. Cleaning state.")
                 self._is_authenticated = False; self._is_connected = False; self._current_actor_name = None
        elif self._debug:
            logger.info(f"[Vitrus] disconnect_if_actor: SDK not connected as '{actor_name_to_disconnect}' (currently: {self._current_actor_name or 'agent/none'}). No action.")

    async def close(self) -> None:
        """Gracefully closes the WebSocket connection and cleans up resources."""
        if self._debug: logger.info("[Vitrus] Initiating graceful shutdown of SDK instance.")
        await self._close_ws_internal(graceful=True)

    def _ws_is_open(self) -> bool:
        """
        Helper to check if the websocket connection is open.
        Compatible with different websockets library versions.
        """
        if self._ws is None:
            return False
        
        # Try different approaches based on websockets library version
        try:
            # For newer websockets versions (15.x+) - check state
            if hasattr(self._ws, 'state'):
                from websockets.protocol import State
                return self._ws.state == State.OPEN
        except (ImportError, AttributeError):
            pass
        
        try:
            # For legacy versions - check open property
            if hasattr(self._ws, 'open'):
                return self._ws.open
        except AttributeError:
            pass
        
        try:
            # For some versions - check closed property
            if hasattr(self._ws, 'closed'):
                return not self._ws.closed
        except AttributeError:
            pass
        
        # Fallback - assume open if websocket exists and no explicit close method available
        return True
