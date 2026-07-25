import { Droid } from './droid-live.js';

export * from './droid-live.js';
export * from './contracts.js';
export * from './golden-edge.js';

/**
 * Vitrus SDK
 *
 * TypeScript client for the Vitrus DAO. Actor/Agent communication model with workflow orchestration.
 *
 * Communication: All agent–actor traffic (commands, responses, broadcasts, events) goes through
 * the DAO WebSocket. No Zenoh in the TS SDK (avoids WASM/Node issues). Python SDK uses Zenoh
 * for Python↔Python; DAO bridges WebSocket ↔ Zenoh for cross-language.
 */

// Load version dynamically - avoiding JSON import which requires TypeScript config changes
let SDK_VERSION: string; // Fallback version matching package.json
const DEFAULT_BASE_URL = 'wss://vitrus-dao.onrender.com';

try {
    // For Node.js/Bun environments
    if (typeof require !== 'undefined') {
        const pkg = require('../package.json');
        SDK_VERSION = pkg.version;
    }
} catch (e) {
    // Fallback to hardcoded version if package.json can't be loaded
    console.warn('Could not load version from package.json, using fallback version');
}

// Types for message handling
type ClientType = 'actor' | 'agent' | 'unknown';

interface HandshakeMessage {
    type: 'HANDSHAKE';
    clientType?: ClientType;
    worldId?: string;
    apiKey: string;
    actorName?: string;
    actorId?: string;
    registeredCommands?: Array<{ name: string; parameterTypes: Array<string> }>;
    metadata?: any; // Actor metadata for registration
    agentName?: string;
}

interface HandshakeResponseMessage {
    type: 'HANDSHAKE_RESPONSE';
    success: boolean;
    clientId: string;
    userId?: string;
    error_code?: string;
    message?: string;
    routerUrl?: string;
    /** WebSocket endpoint for Zenoh (TS SDK uses this to avoid WASM) */
    routerUrlWs?: string;
    actorId?: string;
    serverIp?: string;
    worldExists?: boolean;
    actorInfo?: {
        metadata: any;
        registeredCommands: Array<{
            name: string;
            parameterTypes: Array<string>;
        }>;
    };
}

interface CommandMessage {
    type: 'COMMAND';
    senderType: ClientType;
    senderName: string;
    targetType: ClientType | 'broadcast';
    targetName?: string;
    commandName: string;
    args: any;
    requestId: string;
    sourceChannel?: string; // Channel to reply to
    worldId?: string;
}

interface ResponseMessage {
    type: 'RESPONSE';
    targetChannel: string;
    requestId: string;
    commandId: string;
    result?: any;
    error?: string;
}

interface RegisterCommandMessage {
    type: 'REGISTER_COMMAND';
    actorName: string;
    commandName: string;
    parameterTypes: Array<string>; // Array of parameter types
}

interface WorkflowInvocationMessage {
    type: 'WORKFLOW_INVOCATION';
    workflowName: string;
    args: any;
    requestId: string;
}

interface WorkflowResultMessage {
    type: 'WORKFLOW_RESULT';
    requestId: string;
    result?: any;
    error?: string;
}

// --- OpenAI Tool Schema Types for Workflows (Mirrored from DAO) ---
interface JSONSchema {
    type: 'object' | 'string' | 'number' | 'boolean' | 'array';
    description?: string;
    properties?: Record<string, JSONSchema>;
    required?: string[];
    items?: JSONSchema;
    additionalProperties?: boolean;
}

// Renamed from OpenAIFunction
interface OpenAITool {
    name: string;
    description?: string;
    parameters: JSONSchema;
    strict?: boolean;
}

interface WorkflowDefinition {
    type: 'function';
    function: OpenAITool; // Use OpenAITool
}

// --- Get Actor Info (from Supabase via DAO) ---
interface GetActorInfoMessage {
    type: 'GET_ACTOR_INFO';
    worldId: string;
    actorName: string;
    requestId: string;
}

interface GetActorInfoResponseMessage {
    type: 'GET_ACTOR_INFO_RESPONSE';
    requestId: string;
    actor?: {
        id: string;
        name: string;
        world_id: string;
        info: any;
        device_id: string | null;
        state: string;
        created_at: string;
        updated_at: string;
        registeredCommands?: Array<{ name: string; parameterTypes: Array<string> }>;
    };
    error?: string;
}

// --- Workflow Listing Messages ---
interface ListWorkflowsMessage {
    type: 'LIST_WORKFLOWS';
    requestId: string;
}

interface WorkflowListMessage {
    type: 'WORKFLOW_LIST';
    requestId: string;
    workflows?: WorkflowDefinition[]; // Use WorkflowDefinition[]
    error?: string;
}

interface ActorBroadcastEmitMessage {
    type: 'BROADCAST' | 'EVENT';
    eventName?: string;
    broadcastName?: string;
    args: any;
}

interface ActorBroadcastMessage {
    type: 'ACTOR_BROADCAST' | 'ACTOR_EVENT';
    actorName: string;
    eventName?: string;
    broadcastName?: string;
    args: any;
}

// Utility for extracting parameter types from function signatures
function getParameterTypes(func: Function): Array<string> {
    // Convert function to string and analyze parameters
    const funcStr = func.toString();
    const argsMatch = funcStr.match(/\(([^)]*)\)/);

    if (!argsMatch || !argsMatch[1].trim()) {
        return [];
    }

    const args = argsMatch[1].split(',');
    return args.map(arg => {
        // Try to extract type information if available
        const typeMatch = arg.trim().match(/(.*?):(.*)/);
        if (typeMatch && typeMatch[2]) {
            return typeMatch[2].trim();
        }
        return 'any';
    });
}

/** Supabase-backed actor record (id, info, device_id, state, etc.) */
export interface ActorRecord {
    id: string;
    name: string;
    world_id: string;
    info: any;
    device_id?: string | null;
    state: string;
    created_at: string;
    updated_at: string;
    registeredCommands?: Array<{ name: string; parameterTypes: Array<string> }>;
}

// Actor/Player class
class Actor {
    private vitrus: Vitrus;
    private _name: string;
    private metadata: any;
    private commandHandlers: Map<string, Function> = new Map();
    /** Supabase actor record (id, info, device_id, state, etc.) when fetched via actor(name) as agent */
    private record: ActorRecord | null = null;

    constructor(vitrus: Vitrus, name: string, metadata: any = {}, record?: ActorRecord | null) {
        this.vitrus = vitrus;
        this._name = name;
        this.metadata = record?.info != null ? { ...record.info, ...metadata } : metadata;
        this.record = record ?? null;
    }

    /** Actor name (always set) */
    get name(): string { return this._name; }
    /** Actor ID from Supabase (when fetched via actor(name)) */
    get id(): string | undefined { return this.record?.id; }
    /** Actor info/metadata from Supabase */
    get info(): any { return this.record?.info ?? this.metadata; }
    /** Associated device ID from Supabase */
    get deviceId(): string | null | undefined { return this.record?.device_id; }
    /** Actor state from Supabase (e.g. connected, disconnected) */
    get state(): string | undefined { return this.record?.state; }
    /** Registered commands from DAO/Supabase */
    get registeredCommands(): Array<{ name: string; parameterTypes: Array<string> }> | undefined { return this.record?.registeredCommands; }

    /**
     * Register a command handler
     */
    on(commandName: string, handler: Function): Actor {
        this.commandHandlers.set(commandName, handler);

        // Extract parameter types
        const parameterTypes = getParameterTypes(handler);

        // Register with Vitrus (local handler map)
        this.vitrus.registerActorCommandHandler(this._name, commandName, handler, parameterTypes);

        // Register command with server *only if* currently connected as this actor
        if (this.vitrus.getIsAuthenticated() && this.vitrus.getActorName() === this._name) {
            this.vitrus.registerCommand(this._name, commandName, parameterTypes);
        } else if (this.vitrus.getDebug()) {
            console.log(`[Vitrus SDK - Actor.on] Not sending REGISTER_COMMAND for ${commandName} on ${this._name} as SDK is not authenticated as this actor.`);
        }

        return this;
    }

    /**
     * Run a command on an actor
     */
    async run(commandName: string, ...args: any[]): Promise<any> {
        return this.vitrus.runCommand(this._name, commandName, args);
    }

    /**
     * Broadcast an event to all agents subscribed to this actor's event (actor-side only).
     * Call when connected as this actor.
     */
    async broadcast(eventName: string, data: any): Promise<void> {
        return this.vitrus.broadcastActorEvent(this._name, eventName, data);
    }

    /**
     * Subscribe to this actor's broadcast events (agent-side). Callback receives event data.
     */
    event(eventName: string, callback: (data: any) => void): Actor {
        this.vitrus.subscribeActorEvent(this._name, eventName, callback);
        return this;
    }

    /**
     * Alias for event(). Subscribe to this actor's broadcasts (agent-side). e.g. actor.listen('telemetry', (data) => { ... })
     */
    listen(eventName: string, callback: (data: any) => void): Actor {
        return this.event(eventName, callback);
    }

    /**
     * Get actor metadata
     */
    getMetadata(): any {
        return this.metadata;
    }

    /**
     * Update actor metadata
     */
    updateMetadata(newMetadata: any): void {
        this.metadata = { ...this.metadata, ...newMetadata };
        // TODO: Send metadata update to server
    }

    /**
     * Disconnect the actor if the SDK is currently connected as this actor.
     */
    disconnect(): void {
        this.vitrus.disconnectIfActor(this.name);
    }
}

// Scene class
class Scene {
    private vitrus: Vitrus;
    private sceneId: string;

    constructor(vitrus: Vitrus, sceneId: string) {
        this.vitrus = vitrus;
        this.sceneId = sceneId;
    }

    /**
     * Set a structure to the scene
     */
    set(structure: any): void {
        // Implementation would update scene structure
    }

    /**
     * Add an object to the scene
     */
    add(object: any): void {
        // Implementation would add object to scene
    }

    /**
     * Update an object in the scene
     */
    update(params: { id: string, [key: string]: any }): void {
        // Implementation would update object in scene
    }

    /**
     * Remove an object from the scene
     */
    remove(objectId: string): void {
        // Implementation would remove object from scene
    }

    /**
     * Get the scene
     */
    get(): any {
        // Implementation would fetch scene data
        return { id: this.sceneId };
    }
}

// EventEmitter-like interface (Node.js/ws style)
interface EventEmitter {
    on(event: string, listener: (...args: any[]) => void): void;
    removeListener(event: string, listener: (...args: any[]) => void): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    readonly readyState: number;
}

/** Vitrus client. All agent/actor traffic over DAO WebSocket (no Zenoh in TS). */
class Vitrus {
    /**
     * Modern device-first API. It intentionally does not use the legacy
     * DAO actor protocol: Droid requests target the Vitrus data plane.
     */
    static readonly Droid = Droid;
    private ws: EventEmitter | null = null;
    private apiKey: string;
    private worldId?: string;
    private clientId: string = '';
    private connected: boolean = false;
    private authenticated: boolean = false;
    private messageHandlers: Map<string, Function[]> = new Map();
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map();
    private actorCommandHandlers: Map<string, Map<string, Function>> = new Map();
    private actorCommandSignatures: Map<string, Map<string, Array<string>>> = new Map();
    private actorMetadata: Map<string, any> = new Map();
    private baseUrl: string;
    private debug: boolean;
    private actorName?: string;
    private actorIds: Map<string, string> = new Map();
    private actorEventListeners: Map<string, Map<string, Function[]>> = new Map(); // actorName -> eventName -> callbacks
    private connectionPromise: Promise<void> | null = null;
    private _connectionReject: ((reason?: any) => void) | null = null; // To store the reject of connectionPromise
    private serverIp?: string;
    private worldExists?: boolean;

    // WebSocket readyState constants
    private static readonly OPEN = 1;

    constructor({
        apiKey,
        world,
        baseUrl = DEFAULT_BASE_URL,
        debug = false
    }: {
        apiKey: string,
        world?: string,
        baseUrl?: string,
        debug?: boolean
    }) {
        this.apiKey = apiKey;
        this.worldId = world;
        this.baseUrl = baseUrl;
        this.debug = debug;

        if (this.debug) {
            console.log(`[Vitrus v${SDK_VERSION}] Initializing with options:`, { apiKey: '***', world, baseUrl, debug });
        }
        // Don't connect automatically - wait for authenticate() or explicit connect()
    }

    /**
     * Connect to the WebSocket server with authentication
     * @internal This is mainly for internal use, users should use authenticate()
     */
    async connect(actorName?: string, metadata?: any): Promise<void> {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }
        this.actorName = actorName || this.actorName;
        if (this.actorName && metadata) {
            this.actorMetadata.set(this.actorName, metadata);
        }

        this.connectionPromise = new Promise<void>(async (resolve, reject) => {
            this._connectionReject = reject; // Store reject function for onerror/onclose
            try {
                await this._establishWebSocketConnection(); // This method will handle ws setup and waitForAuthentication
                resolve();
            } catch (error) {
                reject(error); // Errors from _establishWebSocketConnection or waitForAuthentication will be caught here
            }
        });
        return this.connectionPromise;
    }

    private async _establishWebSocketConnection(): Promise<void> {
        if (this.debug) console.log(`[Vitrus] Attempting to connect to WebSocket server:`, this.baseUrl);

        const url = new URL(this.baseUrl);
        url.searchParams.append('apiKey', this.apiKey);
        if (this.worldId) {
            url.searchParams.append('worldId', this.worldId);
        }

        const isBrowserEnvironment = typeof window !== 'undefined' && typeof window.document !== 'undefined';
        const SelectedWS = isBrowserEnvironment ? window.WebSocket : require('ws'); // Renamed to avoid conflict

        if (!SelectedWS) {
             throw new Error('WebSocket constructor not found. Environment detection failed or WebSocket is not available.');
        }

        const rawWs = new SelectedWS(url.toString());

        if (isBrowserEnvironment) {
            // Browser environment: Wrap the native WebSocket to provide .on() and .removeListener()
            this.ws = this.createBrowserWsWrapper(rawWs as unknown as globalThis.WebSocket);
        } else {
            // Node/Bun environment: Use ws instance directly
            this.ws = rawWs as EventEmitter; // Cast to our EventEmitter interface
        }

        if (!this.ws) {
            throw new Error('Failed to create or wrap WebSocket instance');
        }

        // Setup event handlers using Node/Bun .on() syntax
        this.ws.on('open', () => { 
            this.connected = true;
            if (this.debug) console.log('[Vitrus] Connected to WebSocket server (onopen)');
            
            // Send HANDSHAKE message
            const registeredCommands = this.actorName
                ? this.getRegisteredCommands(this.actorName)
                : undefined;
            const handshakeMsg: HandshakeMessage = {
                type: 'HANDSHAKE',
                clientType: this.actorName ? 'actor' : 'agent',
                apiKey: this.apiKey,
                worldId: this.worldId,
                actorName: this.actorName,
                actorId: this.actorName ? this.actorIds.get(this.actorName) : undefined,
                registeredCommands,
                metadata: this.actorName ? this.actorMetadata.get(this.actorName) : undefined
            };
            if (this.debug) console.log('[Vitrus] Sending HANDSHAKE message:', handshakeMsg);
            this.sendMessage(handshakeMsg).catch(sendError => {
                console.error('[Vitrus] Failed to send HANDSHAKE message:', sendError);
                if (this._connectionReject) {
                    this._connectionReject(new Error(`Failed to send HANDSHAKE message: ${sendError.message}`));
                    this._connectionReject = null; 
                }
                if (this.ws) {
                    try {
                        this.ws.close();
                    } catch (closeError) {
                        if (this.debug) console.log('[Vitrus] Error attempting to close WebSocket after failed handshake send:', closeError);
                    }
                }
            });
        });

        this.ws.on('message', (data: any) => { // Reverted to .on('message', ...)
            try {
                // Node/ws provides data directly
                const message = JSON.parse(typeof data === 'string' ? data : data.toString()); 
                if (this.debug && message.type !== 'HANDSHAKE_RESPONSE') {
                    console.log('[Vitrus] Received message (generic handler):', message);
                }
                this.handleMessage(message); 
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });

        this.ws.on('error', (error: Error) => { // Reverted to .on('error', ...)
            if (!this.connected) { // Error before connection fully established
                 let specificError = error; // Use the actual error object from ws
                 if (this.worldId) {
                     specificError = new Error(`Connection Failed: Unable to connect to world '${this.worldId}'. This world may not exist, or the API key may be invalid. Original: ${error.message}`);
                 } else {
                     specificError = new Error(`Connection Failed: Unable to establish initial WebSocket connection. Original: ${error.message}`);
                 }
                 console.error(specificError.message);
                 if (this.debug) console.log('[Vitrus] WebSocket connection error (pre-connect):', specificError);
                if (this._connectionReject) {
                    this._connectionReject(specificError);
                    this._connectionReject = null; // Prevent multiple rejections
                }
            } else { // Error after connection
                console.error('WebSocket error (post-connect):', error.message);
                 if (this.debug) console.log('[Vitrus] WebSocket error (post-connect):', error);
            }
        });

        this.ws.on('close', (code: number, reason: Buffer) => { // Reverted to .on('close', ...)
            const wasConnected = this.connected;
            this.connected = false;
            this.authenticated = false;
            const reasonStr = reason.toString();

            if (!wasConnected) { // Closed before connection was fully established and authenticated
                 if (this.debug) console.log(`[Vitrus] WebSocket closed before full connection/authentication. Code: ${code}, Reason: ${reasonStr}`);
                if (this._connectionReject) {
                    this._connectionReject(new Error(`Connection Attempt Failed: WebSocket closed before connection could be established. Code: ${code}, Reason: ${reasonStr}`));
                    this._connectionReject = null;
                }
            } else {
                 if (this.debug) console.log(`[Vitrus] Disconnected from WebSocket server (onclose after connection). Code: ${code}, Reason: ${reasonStr}`);
                 const closeError = new Error(`Connection Lost: The connection to the Vitrus server was lost. Code: ${code}, Reason: ${reasonStr}`);
                console.error(closeError.message);
                // Reject any pending requests
                for (const [requestId, { reject }] of this.pendingRequests.entries()) {
                    reject(closeError);
                    this.pendingRequests.delete(requestId);
                }
            }
            this.connectionPromise = null; // Allow new connection attempts
        });

        // Now, wait for the authentication process to complete.
        await this.waitForAuthentication();
    }

    // Helper to create a wrapper for Browser WebSocket
    private createBrowserWsWrapper(browserWs: globalThis.WebSocket): EventEmitter {
        const listeners: { [key: string]: ((...args: any[]) => void)[] } = {};

        const getListeners = (event: string) => {
            if (!listeners[event]) {
                listeners[event] = [];
            }
            return listeners[event];
        };

        const wrapper: EventEmitter = {
            on: (event: string, listener: (...args: any[]) => void) => {
                getListeners(event).push(listener);
                switch (event) {
                    case 'open':
                        browserWs.onopen = (ev: Event) => getListeners('open').forEach(l => l(ev));
                        break;
                    case 'message':
                        browserWs.onmessage = (ev: MessageEvent) => getListeners('message').forEach(l => l(ev.data));
                        break;
                    case 'error':
                        browserWs.onerror = (ev: Event) => getListeners('error').forEach(l => l(ev)); // Browser error is just Event
                        break;
                    case 'close':
                        browserWs.onclose = (ev: CloseEvent) => getListeners('close').forEach(l => l(ev.code, ev.reason));
                        break;
                }
            },
            removeListener: (event: string, listener: (...args: any[]) => void) => {
                const eventListeners = getListeners(event);
                const index = eventListeners.indexOf(listener);
                if (index > -1) {
                    eventListeners.splice(index, 1);
                }
                // If no listeners remain for an event, clear the native handler
                if (eventListeners.length === 0) {
                    switch (event) {
                        case 'open': browserWs.onopen = null; break;
                        case 'message': browserWs.onmessage = null; break;
                        case 'error': browserWs.onerror = null; break;
                        case 'close': browserWs.onclose = null; break;
                    }
                }
            },
            send: (data: string) => browserWs.send(data),
            close: (code?: number, reason?: string) => browserWs.close(code, reason),
            get readyState() { return browserWs.readyState; },
        };
        return wrapper;
    }

    private async waitForConnection(): Promise<void> {
        if (this.connected) return;

        if (this.debug) console.log('[Vitrus] Waiting for connection...');
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.connected) {
                    clearInterval(checkInterval);
                    if (this.debug) console.log('[Vitrus] Connection established');
                    resolve();
                }
            }, 100);
        });
    }

    private async waitForAuthentication(): Promise<void> {
        if (this.authenticated) return;

        if (this.debug) console.log('[Vitrus] Waiting for authentication...');
        return new Promise((resolve, reject) => {
            const handleAuthResponse = (message: any) => {
                if (message.type === 'HANDSHAKE_RESPONSE') {
                    const response = message as HandshakeResponseMessage;
                    if (response.success) {
                        this.clientId = response.clientId;
                        this.authenticated = true;
                        if (response.actorId && this.actorName) {
                            this.actorIds.set(this.actorName, response.actorId);
                        }
                        if (response.serverIp) {
                            this.serverIp = response.serverIp;
                        }
                        if (typeof response.worldExists === 'boolean') {
                            this.worldExists = response.worldExists;
                        }

                        // If actor info was included, restore it
                        if (response.actorInfo && this.actorName) {
                            // Store the actor metadata
                            this.actorMetadata.set(this.actorName, response.actorInfo.metadata);

                            // Re-register existing commands if available
                            if (response.actorInfo.registeredCommands) {
                                if (this.debug) console.log('[Vitrus] Restoring registered commands:', response.actorInfo.registeredCommands);

                                // Create a signature map if it doesn't exist
                                if (!this.actorCommandSignatures.has(this.actorName)) {
                                    this.actorCommandSignatures.set(this.actorName, new Map());
                                }

                                // Restore command signatures
                                const signatures = this.actorCommandSignatures.get(this.actorName)!;
                                for (const cmd of response.actorInfo.registeredCommands) {
                                    signatures.set(cmd.name, cmd.parameterTypes);
                                }
                            }
                        }

                        if (this.debug) console.log('[Vitrus] Authentication successful, clientId:', this.clientId);
                        if (this.ws) {
                            this.ws.removeListener('message', handleAuthResponseWrapper);
                        }
                        resolve();
                    } else {
                        let errorMessage = response.message || 'Authentication failed';
                        // Check for specific error codes or messages from the DAO
                        if (response.error_code === 'invalid_api_key') { // Explicit check for invalid_api_key
                            errorMessage = "Authentication Failed: The provided API Key is invalid or expired.";
                        } else if (response.error_code === 'world_not_found') { // Explicit check for world_not_found (from URL)
                            // Use the message directly from the server as it's already formatted
                            errorMessage = response.message || `Connection Failed: The world specified in the connection URL was not found.`;
                        } else if (response.error_code === 'world_not_found_handshake') { // Explicit check for world from handshake msg
                            errorMessage = response.message || `Connection Failed: The world specified in the handshake message was not found.`;
                        } else if (errorMessage.includes('Actors require a worldId')) { // Fallback message check
                            errorMessage = "Connection Failed: An actor connection requires a valid World ID to be specified.";
                        }
                        // Add more specific checks for other error_codes/messages as needed

                        if (this.debug) console.log('[Vitrus] Authentication failed:', errorMessage);
                        if (this.ws) {
                            this.ws.removeListener('message', handleAuthResponseWrapper);
                        }
                        reject(new Error(errorMessage));
                    }
                }
            };

            const handleAuthResponseWrapper = (data: any) => { // Node style takes data directly
                try {
                    const message = JSON.parse(typeof data === 'string' ? data : data.toString());
                    handleAuthResponse(message);
                } catch (error) {
                    // Ignore parse errors
                }
            };

            if (this.ws) {
                // Use Node/Bun style .on() and .removeListener()
                this.ws.on('message', handleAuthResponseWrapper);

                // Add temporary error/close handlers for auth period using .on()
                const handleAuthError = (error: Error) => {
                    if (!this.authenticated) {
                        console.error('[Vitrus] WebSocket error during authentication wait:', error.message);
                        reject(new Error(`WebSocket error during authentication: ${error.message}`));
                        // Clean up listeners after handling the error
                        this.ws?.removeListener('message', handleAuthResponseWrapper);
                        this.ws?.removeListener('error', handleAuthError);
                        this.ws?.removeListener('close', handleAuthClose);
                    }
                };
                const handleAuthClose = (code: number, reason: Buffer) => {
                     if (!this.authenticated) {
                        const reasonStr = reason.toString();
                        console.error(`[Vitrus] WebSocket closed during authentication wait. Code: ${code}, Reason: ${reasonStr}`);
                        reject(new Error(`WebSocket closed during authentication. Code: ${code}, Reason: ${reasonStr}`));
                         // Clean up listeners after handling the close
                        this.ws?.removeListener('message', handleAuthResponseWrapper);
                        this.ws?.removeListener('error', handleAuthError);
                        this.ws?.removeListener('close', handleAuthClose);
                     }
                };

                this.ws.on('error', handleAuthError);
                this.ws.on('close', handleAuthClose);

                // The cleanup for successful auth or specific failure is handled inside handleAuthResponse
                 // We also need to remove error/close listeners there.
                 const originalResolve = resolve;
                 const originalReject = reject;
                 resolve = () => {
                     this.ws?.removeListener('error', handleAuthError);
                     this.ws?.removeListener('close', handleAuthClose);
                     originalResolve();
                 }
                 reject = (err) => {
                      this.ws?.removeListener('error', handleAuthError);
                      this.ws?.removeListener('close', handleAuthClose);
                      originalReject(err);
                 }
            }
        });
    }

    private async sendMessage(message: any): Promise<void> {
        // Ensure we're connected
        if (!this.connected) {
            await this.connect();
        }

        if (this.ws && this.ws.readyState === Vitrus.OPEN) {
            if (this.debug) console.log('[Vitrus] Sending message:', message);
            this.ws.send(JSON.stringify(message));
        } else {
            if (this.debug) console.log('[Vitrus] Failed to send message - WebSocket not connected');
            throw new Error('WebSocket is not connected');
        }
    }

    private handleMessage(message: any): void {
        const { type } = message;

        // Handle handshake response
        if (type === 'HANDSHAKE_RESPONSE') {
            const response = message as HandshakeResponseMessage;
            if (response.success) {
                this.clientId = response.clientId;
                this.authenticated = true;
                if (response.actorId && this.actorName) {
                    this.actorIds.set(this.actorName, response.actorId);
                }
                if (response.serverIp) {
                    this.serverIp = response.serverIp;
                }
                if (typeof response.worldExists === 'boolean') {
                    this.worldExists = response.worldExists;
                }
                if (this.debug) console.log('[Vitrus] Agent/actor communication: WebSocket (DAO)');

                // Process actor info if available
                if (response.actorInfo && this.actorName) {
                    this.actorMetadata.set(this.actorName, response.actorInfo.metadata);

                    // Process command signatures
                    if (response.actorInfo.registeredCommands) {
                        if (!this.actorCommandSignatures.has(this.actorName)) {
                            this.actorCommandSignatures.set(this.actorName, new Map());
                        }

                        const signatures = this.actorCommandSignatures.get(this.actorName)!;
                        for (const cmd of response.actorInfo.registeredCommands) {
                            signatures.set(cmd.name, cmd.parameterTypes);
                        }
                    }
                }

                if (this.debug) console.log('[Vitrus] Handshake successful, clientId:', this.clientId);
            } else {
                console.error('Handshake failed:', response.message);
                if (this.debug) console.log('[Vitrus] Handshake failed:', response.message);
            }
            return;
        }

        // COMMAND: actor receives from DAO over WebSocket
        if (type === 'COMMAND') {
            this.handleCommand(message as CommandMessage);
            return;
        }
        // RESPONSE: agent receives from DAO over WebSocket (result of runCommand)
        if (type === 'RESPONSE') {
            const resp = message as ResponseMessage;
            const pending = this.pendingRequests.get(resp.requestId);
            if (pending) {
                this.pendingRequests.delete(resp.requestId);
                if (resp.error) pending.reject(new Error(resp.error));
                else pending.resolve(resp.result);
            }
            return;
        }
        // ACTOR_BROADCAST: agent receives from DAO over WebSocket (actor event)
        if (type === 'ACTOR_BROADCAST' || type === 'ACTOR_EVENT') {
            const actorName = message.actorName;
            const eventName = message.eventName ?? message.broadcastName;
            const data = message.args ?? {};
            const callbacks = this.actorEventListeners.get(actorName)?.get(eventName) ?? [];
            for (const cb of callbacks) {
                try { cb(data); } catch (err) {
                    if (this.debug) console.log('[Vitrus] Actor event callback error:', err);
                }
            }
            return;
        }

        // Handle workflow results
        if (type === 'WORKFLOW_RESULT') {
            const { requestId, result, error } = message as WorkflowResultMessage;
            if (this.debug) console.log('[Vitrus] Received workflow result for requestId:', requestId, { result, error });

            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                if (error) {
                    pending.reject(new Error(error));
                } else {
                    pending.resolve(result);
                }
                this.pendingRequests.delete(requestId);
            }
            return;
        }

        // Handle workflow list response
        if (type === 'WORKFLOW_LIST') {
            const { requestId, workflows, error } = message as WorkflowListMessage;
            if (this.debug) console.log('[Vitrus] Received workflow list for requestId:', requestId, { workflows, error });

            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                if (error) {
                    pending.reject(new Error(error));
                } else {
                    pending.resolve(workflows || []); // Resolve with the array of WorkflowDefinition
                }
                this.pendingRequests.delete(requestId);
            }
            return;
        }

        // Handle get actor info response (Supabase-backed actor record)
        if (type === 'GET_ACTOR_INFO_RESPONSE') {
            const resp = message as GetActorInfoResponseMessage;
            const pending = this.pendingRequests.get(resp.requestId);
            if (pending) {
                this.pendingRequests.delete(resp.requestId);
                if (resp.error) pending.reject(new Error(resp.error));
                else pending.resolve(resp.actor ?? null);
            }
            return;
        }

        // Handle custom messages
        const handlers = this.messageHandlers.get(type) || [];
        for (const handler of handlers) {
            handler(message);
        }
    }

    private handleCommand(message: CommandMessage): void {
        const { commandName, args, requestId, targetType, targetName, sourceChannel } = message;
        const resolvedActorName = targetType === 'actor'
            ? targetName
            : targetType === 'broadcast'
                ? this.actorName
                : (message as any).targetActorName;

        if (!resolvedActorName) {
            if (this.debug) console.log('[Vitrus] Ignoring command without actor target:', { targetType, targetName });
            return;
        }

        if (this.debug) console.log('[Vitrus] Handling command:', { commandName, targetType, targetName: resolvedActorName, requestId });

        const actorHandlers = this.actorCommandHandlers.get(resolvedActorName);
        if (actorHandlers) {
            const handler = actorHandlers.get(commandName);
            if (handler) {
                if (this.debug) console.log('[Vitrus] Found handler for command:', commandName);

                Promise.resolve()
                    .then(() => handler(...args))
                    .then((result) => {
                        if (this.debug) console.log('[Vitrus] Command executed successfully:', { commandName, result });
                        this.sendResponse({
                            type: 'RESPONSE',
                            targetChannel: sourceChannel || '',
                            requestId,
                            commandId: requestId,
                            result,
                        });
                    })
                    .catch((error: Error) => {
                        if (this.debug) console.log('[Vitrus] Command execution failed:', { commandName, error: error.message });
                        this.sendResponse({
                            type: 'RESPONSE',
                            targetChannel: sourceChannel || '',
                            requestId,
                            commandId: requestId,
                            error: error.message,
                        });
                    });
            } else if (this.debug) {
                console.log('[Vitrus] No handler found for command:', commandName);
            }
        } else if (this.debug) {
            console.log('[Vitrus] No actor found with name:', resolvedActorName);
        }
    }

    private sendResponse(response: ResponseMessage): void {
        if (this.debug) console.log('[Vitrus] Sending response:', response);
        this.sendMessage(response);
    }

    /**
     * Register a command with the server
     */
    async registerCommand(actorName: string, commandName: string, parameterTypes: Array<string>): Promise<void> {
        if (this.debug) console.log('[Vitrus] Registering command with server:', { actorName, commandName, parameterTypes });

        const message: RegisterCommandMessage = {
            type: 'REGISTER_COMMAND',
            actorName,
            commandName,
            parameterTypes
        };

        await this.sendMessage(message);
    }

    private generateRequestId(): string {
        const requestId = Math.random().toString(36).substring(2, 15);
        if (this.debug) console.log('[Vitrus] Generated requestId:', requestId);
        return requestId;
    }

    /**
     * Authenticate with the API
     */
    async authenticate(actorName?: string, metadata?: any): Promise<boolean> {
        if (this.debug) console.log(`[Vitrus] Initiating connection sequence...` + (actorName ? ` (intended actor: ${actorName})` : ''));

        // Require worldId if intending to be an actor
        if (actorName && !this.worldId) {
            throw new Error('Vitrus SDK requires a worldId to authenticate as an actor.');
        }

        // Store actor name and metadata for use in connection
        this.actorName = actorName;
        if (actorName && metadata) {
            this.actorMetadata.set(actorName, metadata);
        }

        // Connect or reconnect
        await this.connect(actorName, metadata);
        return this.authenticated;
    }

    /**
     * Register a command handler for an actor
     */
    registerActorCommandHandler(actorName: string, commandName: string, handler: Function, parameterTypes: Array<string> = []): void {
        if (this.debug) console.log('[Vitrus] Registering command handler:', { actorName, commandName, parameterTypes });

        // Store the command handler
        if (!this.actorCommandHandlers.has(actorName)) {
            this.actorCommandHandlers.set(actorName, new Map());
        }
        const actorHandlers = this.actorCommandHandlers.get(actorName)!;
        actorHandlers.set(commandName, handler);

        // Store the parameter types
        if (!this.actorCommandSignatures.has(actorName)) {
            this.actorCommandSignatures.set(actorName, new Map());
        }
        const actorSignatures = this.actorCommandSignatures.get(actorName)!;
        actorSignatures.set(commandName, parameterTypes);
    }

    private getRegisteredCommands(actorName: string): Array<{ name: string; parameterTypes: Array<string> }> {
        const signatures = this.actorCommandSignatures.get(actorName);
        if (!signatures) {
            return [];
        }
        return Array.from(signatures.entries()).map(([name, parameterTypes]) => ({ name, parameterTypes }));
    }

    /**
     * Actor broadcasts an event to subscribed agents (actor-side). Sent to DAO over WebSocket.
     */
    async broadcastActorEvent(actorName: string, eventName: string, data: any): Promise<void> {
        if (!this.authenticated || this.actorName !== actorName) {
            throw new Error('Must be authenticated as this actor to broadcast');
        }
        const payload = {
            type: 'ACTOR_BROADCAST',
            actorName,
            eventName,
            args: data ?? {},
            worldId: this.worldId,
        };
        await this.sendMessage(payload);
        if (this.debug) console.log('[Vitrus] Broadcast via WebSocket (event=' + eventName + ')');
    }

    /**
     * Agent subscribes to an actor's event (agent-side). Sent to DAO over WebSocket; DAO forwards ACTOR_BROADCAST to this client.
     */
    subscribeActorEvent(actorName: string, eventName: string, callback: (data: any) => void): void {
        if (!this.actorEventListeners.has(actorName)) {
            this.actorEventListeners.set(actorName, new Map());
        }
        const eventMap = this.actorEventListeners.get(actorName)!;
        const list = eventMap.get(eventName) ?? [];
        list.push(callback);
        eventMap.set(eventName, list);
        this.sendMessage({ type: 'SUBSCRIBE_ACTOR_EVENT', actorName, eventName }).catch(() => {});
    }

    /**
     * Create or get an actor
     * If options (metadata) are provided, connects and authenticates as this actor.
     * If only name is provided, returns a handle for an agent to interact with.
     */
    /** Fetch actor record from DAO/Supabase (id, info, device_id, state, registeredCommands). Agent-only. */
    async getActorInfo(actorName: string): Promise<ActorRecord | null> {
        if (!this.worldId) throw new Error('Vitrus SDK requires a worldId to fetch actor info.');
        if (!this.authenticated) await this.authenticate();
        const requestId = this.generateRequestId();
        const msg: GetActorInfoMessage = { type: 'GET_ACTOR_INFO', worldId: this.worldId, actorName, requestId };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.delete(requestId)) reject(new Error('GET_ACTOR_INFO timeout'));
            }, 10000);
            this.pendingRequests.set(requestId, {
                resolve: (r: ActorRecord | null) => { clearTimeout(timeout); resolve(r); },
                reject: (e: Error) => { clearTimeout(timeout); reject(e); }
            });
            this.sendMessage(msg).catch((e) => { this.pendingRequests.delete(requestId); clearTimeout(timeout); reject(e); });
        });
    }

    async actor(name: string, options?: any): Promise<Actor> {
        if (this.debug) console.log('[Vitrus] Creating/getting actor handle:', name, options);

        // Require worldId to create/authenticate as an actor if options are provided
        if (options !== undefined && !this.worldId) {
            throw new Error('Vitrus SDK requires a worldId to create/authenticate as an actor.');
        }

        // When options provided, set actor name before first connect so handshake is sent as actor
        if (options !== undefined) {
            this.actorMetadata.set(name, options);
            this.actorName = name;
        }

        let record: ActorRecord | null = null;
        // Fetch actor record only in agent mode (when options undefined). In actor mode skip to start fast.
        if (this.worldId && options === undefined) {
            if (!this.authenticated) await this.authenticate();
            try {
                record = await this.getActorInfo(name);
            } catch (e) {
                if (this.debug) console.log(`[Vitrus] Could not fetch actor info for ${name}:`, e);
            }
        }

        const actor = new Actor(this, name, options !== undefined ? options : {}, record);

        // If options are provided (even an empty object), it implies intent to *be* this actor,
        // so authenticate (and wait for it) if necessary.
        if (options !== undefined && (!this.authenticated || this.actorName !== name)) {
            if (this.debug) console.log(`[Vitrus] Options provided for actor ${name}, ensuring authentication as this actor...`);
            try {
                await this.authenticate(name, options);
                if (this.debug) console.log(`[Vitrus] Successfully authenticated as actor ${name}.`);

                // After successful auth, ensure any commands queued via .on() are registered
                await this.registerPendingCommands(name);
            } catch (error) {
                console.error(`Failed to auto-authenticate actor ${name}:`, error);
                throw error;
            }
        }

        return actor;
    }

    /**
     * Get a scene
     */
    scene(sceneId: string): Scene {
        if (this.debug) console.log('[Vitrus] Getting scene:', sceneId);
        return new Scene(this, sceneId);
    }

    /**
     * Run a command on an actor
     */
    async runCommand(actorName: string, commandName: string, args: any[]): Promise<any> {
        if (this.debug) console.log('[Vitrus] Running command:', { actorName, commandName, args });

        // Require worldId to run commands
        if (!this.worldId) {
            throw new Error('Vitrus SDK requires a worldId to run commands on actors.');
        }

        // If not authenticated yet, auto-authenticate (will default to agent if no actor context)
        if (!this.authenticated) {
            await this.authenticate();
        }

        const requestId = this.generateRequestId();
        if (this.debug) {
            console.log('[Vitrus] Sending command via WebSocket (actor=' + actorName + ', command=' + commandName + ')');
        }
        const command: CommandMessage = {
            type: 'COMMAND',
            senderType: 'agent',
            senderName: this.clientId || 'agent',
            targetType: 'actor',
            targetName: actorName,
            commandName,
            args,
            requestId,
            worldId: this.worldId
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.delete(requestId)) {
                    reject(new Error('Command timeout'));
                }
            }, 30000);
            this.pendingRequests.set(requestId, {
                resolve: (r: any) => {
                    clearTimeout(timeout);
                    resolve(r);
                },
                reject: (e: Error) => {
                    clearTimeout(timeout);
                    reject(e);
                }
            });
            this.sendMessage(command).catch((error) => {
                if (this.pendingRequests.delete(requestId)) {
                    clearTimeout(timeout);
                    reject(error);
                }
            });
        });
    }

    /**
     * Run a workflow
     */
    async workflow(workflowName: string, args: any = {}): Promise<any> {
        if (this.debug) console.log('[Vitrus] Running workflow:', { workflowName, args });

        // Preserve existing authentication state - don't force re-auth as agent
        if (!this.authenticated) {
            // If we have a current actor name, re-authenticate as that actor
            if (this.actorName) {
                await this.authenticate(this.actorName, this.actorMetadata.get(this.actorName));
            } else {
                await this.authenticate(); // Authenticate as agent only if no actor context
            }
        }

        const requestId = this.generateRequestId();

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });

            const workflow: WorkflowInvocationMessage = {
                type: 'WORKFLOW_INVOCATION',
                workflowName,
                args,
                requestId,
            };

            this.sendMessage(workflow)
                .catch((error) => {
                    if (this.debug) console.log('[Vitrus] Failed to send workflow:', error);
                    this.pendingRequests.delete(requestId);
                    reject(error);
                });
        });
    }

    /**
     * Upload an image
     */
    async upload_image(image: any, filename: string = "image"): Promise<string> {
        if (this.debug) console.log('[Vitrus] Uploading image:', filename);
        // Implementation would handle image uploads
        // For now, just return a mock URL
        return `https://vitrus.io/images/${filename}`;
    }

    /**
     * Add a record
     */
    async add_record(data: any, name?: string): Promise<string> {
        if (this.debug) console.log('[Vitrus] Adding record:', { data, name });
        // Implementation would store the record
        // For now, just return success
        return name || this.generateRequestId();
    }

    /**
     * List available workflows on the server, including their definitions (OpenAI Tool Schema)
     */
    async list_workflows(): Promise<WorkflowDefinition[]> {
        if (this.debug) console.log('[Vitrus] Requesting workflow list with definitions...');

        // Preserve existing authentication state - don't force re-auth as agent
        if (!this.authenticated) {
            // If we have a current actor name, re-authenticate as that actor
            if (this.actorName) {
                await this.authenticate(this.actorName, this.actorMetadata.get(this.actorName));
            } else {
                await this.authenticate(); // Authenticate as agent only if no actor context
            }
        }

        const requestId = this.generateRequestId();

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });

            const message: ListWorkflowsMessage = {
                type: 'LIST_WORKFLOWS',
                requestId,
            };

            this.sendMessage(message)
                .catch((error) => {
                    if (this.debug) console.log('[Vitrus] Failed to send LIST_WORKFLOWS message:', error);
                    this.pendingRequests.delete(requestId);
                    reject(error);
                });
        });
    }

    /**
     * Helper to register commands that might have been added via actor.on()
     * *before* the initial authentication for that actor completed.
     */
    private async registerPendingCommands(actorName: string): Promise<void> {
        const handlers = this.actorCommandHandlers.get(actorName);
        const signatures = this.actorCommandSignatures.get(actorName);
        if (!handlers || !signatures) return;

        if (this.debug) console.log(`[Vitrus] Registering pending commands for actor ${actorName}...`);

        for (const [commandName, parameterTypes] of signatures.entries()) {
            if (handlers.has(commandName)) { // Ensure handler still exists
                try {
                    await this.registerCommand(actorName, commandName, parameterTypes);
                } catch (error) {
                    console.error(`[Vitrus] Error registering pending command ${commandName} for actor ${actorName}:`, error);
                }
            }
        }
    }

    // --- Public Getters ---
    getIsAuthenticated(): boolean {
        return this.authenticated;
    }

    getActorName(): string | undefined {
        return this.actorName;
    }

    getDebug(): boolean {
        return this.debug;
    }

    /**
     * Disconnects the WebSocket if the SDK is currently authenticated as the specified actor.
     * @param actorName The name of the actor to disconnect.
     */
    disconnectIfActor(actorName: string): void {
        if (this.actorName === actorName && this.authenticated && this.ws && this.ws.readyState === Vitrus.OPEN) {
            if (this.debug) console.log(`[Vitrus] Actor '${actorName}' is disconnecting.`);
            this.ws.close(); 
            // The onclose handler will manage further state changes (this.connected, this.authenticated, etc.)
        } else if (this.debug) {
            if (this.actorName !== actorName) {
                console.log(`[Vitrus] disconnectIfActor: SDK not connected as '${actorName}' (currently: ${this.actorName || 'agent/none'}). No action taken.`);
            } else if (!this.authenticated) {
                console.log(`[Vitrus] disconnectIfActor: SDK not authenticated as '${actorName}'. No action taken.`);
            } else {
                console.log(`[Vitrus] disconnectIfActor: WebSocket for '${actorName}' not open or available. No action taken.`);
            }
        }
    }
}

export default Vitrus;
