/** Device-local auxiliary module catalog and settings contract. */

export type ModuleDataProduct = {
  id: string;
  schema?: string;
  mimeType?: string;
  url?: string;
  meshTopic?: string;
  width?: number;
  height?: number;
  unit?: string;
  sensorRangeC?: { min?: number; max?: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type DeviceModule = {
  schema?: string;
  id: string;
  type: string;
  category?: string;
  displayName: string;
  vendor?: string;
  model?: string;
  transport?: Record<string, unknown>;
  state?: string;
  enabled?: boolean;
  online?: boolean;
  statusText?: string;
  capabilities: string[];
  settingsSchema?: Record<string, unknown>;
  visualization?: Record<string, unknown>;
  dataProducts: ModuleDataProduct[];
  metrics?: Record<string, unknown>;
  firmwareStatus?: Record<string, unknown>;
  frame?: Record<string, unknown>;
  settings: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type DeviceModuleCatalog = {
  schema: string;
  ok: boolean;
  source?: string;
  modules: DeviceModule[];
  moduleSettings?: Record<string, unknown>;
};

export type ModuleConfigureResult = {
  ok: boolean;
  moduleId: string;
  settings: Record<string, unknown>;
  document?: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type DeviceModulesClientOptions = {
  /** Explicit Edge configuration-service origin, e.g. http://r05-edge:8781. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const name = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) throw new Error(`module ${field} must be 1-128 URL-safe characters`);
  return trimmed;
};

function product(value: unknown): ModuleDataProduct | null {
  const raw = record(value);
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  const range = record(raw.sensor_range_c);
  return {
    ...raw,
    id: raw.id,
    ...(typeof raw.schema === "string" ? { schema: raw.schema } : {}),
    ...(typeof raw.mime_type === "string" ? { mimeType: raw.mime_type } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.mesh_topic === "string" ? { meshTopic: raw.mesh_topic } : {}),
    ...(typeof raw.width === "number" ? { width: raw.width } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
    ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
    ...(Object.keys(range).length ? { sensorRangeC: range } : {}),
  };
}

function module(value: unknown): DeviceModule | null {
  const raw = record(value);
  if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.type !== "string" || !raw.type.trim()) return null;
  return {
    id: raw.id,
    type: raw.type,
    displayName: typeof raw.display_name === "string" ? raw.display_name : raw.id,
    ...(typeof raw.schema === "string" ? { schema: raw.schema } : {}),
    ...(typeof raw.category === "string" ? { category: raw.category } : {}),
    ...(typeof raw.vendor === "string" ? { vendor: raw.vendor } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(Object.keys(record(raw.transport)).length ? { transport: record(raw.transport) } : {}),
    ...(typeof raw.state === "string" ? { state: raw.state } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.online === "boolean" ? { online: raw.online } : {}),
    ...(typeof raw.status_text === "string" ? { statusText: raw.status_text } : {}),
    capabilities: strings(raw.capabilities),
    ...(Object.keys(record(raw.settings_schema)).length ? { settingsSchema: record(raw.settings_schema) } : {}),
    ...(Object.keys(record(raw.visualization)).length ? { visualization: record(raw.visualization) } : {}),
    dataProducts: Array.isArray(raw.data_products) ? raw.data_products.map(product).filter((item): item is ModuleDataProduct => item !== null) : [],
    ...(Object.keys(record(raw.metrics)).length ? { metrics: record(raw.metrics) } : {}),
    ...(Object.keys(record(raw.firmware_status)).length ? { firmwareStatus: record(raw.firmware_status) } : {}),
    ...(Object.keys(record(raw.frame)).length ? { frame: record(raw.frame) } : {}),
    settings: record(raw.settings),
    raw,
  };
}

export class DeviceModulesClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DeviceModulesClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    if (!this.endpoint) throw new Error("Edge module endpoint is required");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.requestTimeoutMs ?? 4_000;
  }

  async list(): Promise<DeviceModuleCatalog> {
    const raw = record(await this.request("/api/modules", { method: "GET" }));
    const settings = record(raw.module_settings);
    return {
      schema: typeof raw.schema === "string" ? raw.schema : "vitrus.modules.v1",
      ok: raw.ok === true,
      ...(typeof raw.source === "string" ? { source: raw.source } : {}),
      modules: Array.isArray(raw.modules) ? raw.modules.map(module).filter((item): item is DeviceModule => item !== null) : [],
      ...(Object.keys(settings).length ? { moduleSettings: settings } : {}),
    };
  }

  /** Persists a module-declared settings patch through the explicit Edge configuration service. */
  async configure(id: string, settings: Record<string, unknown>): Promise<ModuleConfigureResult> {
    const moduleId = name(id, "id");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new TypeError("module settings must be an object");
    const raw = record(await this.request("/api/modules/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module_id: moduleId, settings }),
    }));
    return { ok: raw.ok === true, moduleId: typeof raw.module_id === "string" ? raw.module_id : moduleId, settings: record(raw.settings), ...(Object.keys(record(raw.document)).length ? { document: record(raw.document) } : {}), raw };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const detail = record(payload).error ?? record(payload).detail ?? response.statusText;
        throw new Error(`Edge module request failed (${response.status}): ${String(detail)}`);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Edge module service returned invalid JSON");
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}
