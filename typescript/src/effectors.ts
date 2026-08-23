export const EFFECTOR_MODEL_SCHEMA = "vitrus.effector.model.v1" as const;
export const EFFECTOR_COMMANDS_SCHEMA = "vitrus.control.effectors.v1" as const;

export type EffectorVariable = {
  type: "number";
  default: number;
  min: number;
  max: number;
  unit?: string;
};

export type EffectorProfileKeyframe = {
  aperture: number;
  roles: Record<string, number>;
};

export type EffectorDriver = {
  role: string;
  jointName: string;
  zeroPercent: number;
  onePercent: number;
};

export type EffectorModel = {
  schema: typeof EFFECTOR_MODEL_SCHEMA;
  modelId: string;
  revision: string;
  anatomy: string;
  commandType: string;
  variables: Record<string, EffectorVariable>;
  drivers: EffectorDriver[];
  profiles: Record<string, EffectorProfileKeyframe[]>;
  shapeProfiles?: { negative: string; neutral: string; positive: string };
};

export type EffectorInputBinding = {
  input: string;
  variableId: string;
  mode: "rate" | "absolute";
  deadzone?: number;
  invert?: boolean;
  ratePerSecond?: number;
};

export type EffectorTorqueStop = {
  defaultNm: number;
  minNm: number;
  maxNm: number;
  stepNm?: number;
};

export type EffectorInstance = {
  id: string;
  label?: string;
  controllerSide?: "left" | "right";
  available: boolean;
  unavailableReason?: string;
  model: EffectorModel;
  inputBindings: EffectorInputBinding[];
  torqueStop?: EffectorTorqueStop;
};

export type EffectorCommand = {
  effectorId: string;
  modelId: string;
  modelRevision: string;
  commandType: string;
  values: Record<string, number | boolean | string>;
  limits?: { maxTorqueNm?: number };
};

export type EffectorCommandEnvelope = {
  schema: typeof EFFECTOR_COMMANDS_SCHEMA;
  descriptionRevisionId: string;
  commands: EffectorCommand[];
};

export type ResolvedEffectorTarget = {
  jointName: string;
  percent: number;
  role: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`INVALID_EFFECTOR_NUMBER: ${field}`);
  }
  return value;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function parseVariables(value: unknown, effectorId: string): Record<string, EffectorVariable> {
  const parsed: Record<string, EffectorVariable> = {};
  for (const [name, candidate] of Object.entries(record(value))) {
    const raw = record(candidate);
    if (raw.type !== "number") throw new Error(`UNSUPPORTED_EFFECTOR_VARIABLE: ${effectorId}/${name}`);
    const min = finite(raw.min, `${effectorId}/${name}/min`);
    const max = finite(raw.max, `${effectorId}/${name}/max`);
    const defaultValue = finite(raw.default, `${effectorId}/${name}/default`);
    if (!(min < max) || defaultValue < min || defaultValue > max) {
      throw new Error(`INVALID_EFFECTOR_VARIABLE_RANGE: ${effectorId}/${name}`);
    }
    parsed[name] = {
      type: "number",
      min,
      max,
      default: defaultValue,
      ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
    };
  }
  if (!Object.keys(parsed).length) throw new Error(`EFFECTOR_VARIABLES_REQUIRED: ${effectorId}`);
  return parsed;
}

function parseProfiles(value: unknown, roles: Set<string>, effectorId: string): Record<string, EffectorProfileKeyframe[]> {
  const profiles: Record<string, EffectorProfileKeyframe[]> = {};
  for (const [profileName, candidate] of Object.entries(record(value))) {
    const raw = record(candidate);
    const keyframes = Array.isArray(raw.keyframes) ? raw.keyframes : [];
    if (keyframes.length < 2) throw new Error(`EFFECTOR_PROFILE_KEYFRAMES_REQUIRED: ${effectorId}/${profileName}`);
    profiles[profileName] = keyframes.map((item, index) => {
      const row = record(item);
      const aperture = finite(row.aperture, `${effectorId}/${profileName}/${index}/aperture`);
      const roleValues = record(row.roles);
      if (new Set(Object.keys(roleValues)).size !== roles.size || [...roles].some((role) => !(role in roleValues))) {
        throw new Error(`EFFECTOR_PROFILE_ROLE_MISMATCH: ${effectorId}/${profileName}/${index}`);
      }
      return {
        aperture,
        roles: Object.fromEntries([...roles].map((role) => [role, finite(roleValues[role], `${effectorId}/${profileName}/${role}`)])),
      };
    }).sort((a, b) => a.aperture - b.aperture);
  }
  return profiles;
}

export function effectorsFromManifest(manifestValue: unknown): EffectorInstance[] {
  const manifest = record(manifestValue);
  const mechanisms = Array.isArray(manifest.mechanisms) ? manifest.mechanisms : [];
  return mechanisms.flatMap((candidate) => {
    const mechanism = record(candidate);
    const rawModel = record(mechanism.command_model);
    if (mechanism.type !== "semantic_effector" && !Object.keys(rawModel).length) return [];
    const id = typeof mechanism.id === "string" ? mechanism.id.trim() : "";
    if (!id) throw new Error("SEMANTIC_EFFECTOR_ID_REQUIRED");
    if (rawModel.schema !== EFFECTOR_MODEL_SCHEMA) throw new Error(`INVALID_EFFECTOR_MODEL_SCHEMA: ${id}`);
    const modelId = typeof rawModel.model_id === "string" ? rawModel.model_id.trim() : "";
    const revision = typeof rawModel.revision === "string" ? rawModel.revision.trim() : "";
    const anatomy = typeof rawModel.anatomy === "string" ? rawModel.anatomy.trim() : "";
    const commandType = typeof rawModel.command_type === "string" ? rawModel.command_type.trim() : "";
    if (!modelId || !revision || !anatomy || !commandType) throw new Error(`INVALID_EFFECTOR_MODEL_IDENTITY: ${id}`);
    const rawDrivers = Array.isArray(rawModel.drivers) ? rawModel.drivers : [];
    const drivers = rawDrivers.map((candidateDriver) => {
      const driver = record(candidateDriver);
      const role = typeof driver.role === "string" ? driver.role.trim() : "";
      const jointName = typeof driver.joint_name === "string" ? driver.joint_name.trim() : "";
      if (!role || !jointName) throw new Error(`INVALID_EFFECTOR_DRIVER: ${id}`);
      return {
        role,
        jointName,
        zeroPercent: finite(driver.zero_percent, `${id}/${role}/zero_percent`),
        onePercent: finite(driver.one_percent, `${id}/${role}/one_percent`),
      };
    });
    if (!drivers.length || new Set(drivers.map((driver) => driver.role)).size !== drivers.length || new Set(drivers.map((driver) => driver.jointName)).size !== drivers.length) {
      throw new Error(`INVALID_EFFECTOR_DRIVER_SET: ${id}`);
    }
    const roles = new Set(drivers.map((driver) => driver.role));
    const variables = parseVariables(rawModel.variables, id);
    const profiles = parseProfiles(rawModel.profiles, roles, id);
    const rawShapeProfiles = record(rawModel.shape_profiles);
    const shapeProfiles = ["negative", "neutral", "positive"].every((key) => typeof rawShapeProfiles[key] === "string")
      ? {
          negative: String(rawShapeProfiles.negative),
          neutral: String(rawShapeProfiles.neutral),
          positive: String(rawShapeProfiles.positive),
        }
      : undefined;
    if (shapeProfiles && Object.values(shapeProfiles).some((name) => !profiles[name])) {
      throw new Error(`UNKNOWN_EFFECTOR_SHAPE_PROFILE: ${id}`);
    }
    const inputBindings = Array.isArray(mechanism.input_bindings)
      ? mechanism.input_bindings.flatMap((candidateBinding) => {
          const binding = record(candidateBinding);
          if (typeof binding.input !== "string" || typeof binding.variable_id !== "string" || !variables[binding.variable_id]) return [];
          return [{
            input: binding.input,
            variableId: binding.variable_id,
            mode: binding.mode === "absolute" ? "absolute" as const : "rate" as const,
            ...(typeof binding.deadzone === "number" ? { deadzone: binding.deadzone } : {}),
            ...(typeof binding.invert === "boolean" ? { invert: binding.invert } : {}),
            ...(typeof binding.rate_per_second === "number" ? { ratePerSecond: binding.rate_per_second } : {}),
          }];
        })
      : [];
    const rawTorqueStop = record(record(mechanism.safety).torque_stop_nm);
    let torqueStop: EffectorTorqueStop | undefined;
    if (Object.keys(rawTorqueStop).length) {
      const defaultNm = finite(rawTorqueStop.default, `${id}/torque_stop_nm/default`);
      const minNm = finite(rawTorqueStop.min, `${id}/torque_stop_nm/min`);
      const maxNm = finite(rawTorqueStop.max, `${id}/torque_stop_nm/max`);
      const stepNm = rawTorqueStop.step == null ? undefined : finite(rawTorqueStop.step, `${id}/torque_stop_nm/step`);
      if (!(0 < minNm && minNm <= defaultNm && defaultNm <= maxNm) || (stepNm != null && stepNm <= 0)) {
        throw new Error(`INVALID_EFFECTOR_TORQUE_STOP: ${id}`);
      }
      torqueStop = { defaultNm, minNm, maxNm, ...(stepNm == null ? {} : { stepNm }) };
    }
    return [{
      id,
      ...(typeof mechanism.label === "string" ? { label: mechanism.label } : {}),
      ...(mechanism.controller_side === "left" || mechanism.controller_side === "right" ? { controllerSide: mechanism.controller_side } : {}),
      available: mechanism.available !== false,
      ...(typeof mechanism.unavailable_reason === "string" ? { unavailableReason: mechanism.unavailable_reason } : {}),
      inputBindings,
      ...(torqueStop ? { torqueStop } : {}),
      model: {
        schema: EFFECTOR_MODEL_SCHEMA,
        modelId,
        revision,
        anatomy,
        commandType,
        variables,
        drivers,
        profiles,
        ...(shapeProfiles ? { shapeProfiles } : {}),
      },
    }];
  });
}

function interpolateProfile(model: EffectorModel, profileName: string, aperture: number): Record<string, number> {
  const rows = model.profiles[profileName];
  if (!rows?.length) throw new Error(`UNKNOWN_EFFECTOR_PROFILE: ${model.modelId}/${profileName}`);
  if (aperture <= rows[0].aperture) return { ...rows[0].roles };
  if (aperture >= rows[rows.length - 1].aperture) return { ...rows[rows.length - 1].roles };
  let upperIndex = 1;
  while (upperIndex < rows.length && aperture > rows[upperIndex].aperture) upperIndex += 1;
  const lower = rows[upperIndex - 1];
  const upper = rows[upperIndex];
  const span = upper.aperture - lower.aperture;
  const t = span <= 0 ? 0 : (aperture - lower.aperture) / span;
  return Object.fromEntries(model.drivers.map(({ role }) => [
    role,
    lower.roles[role] + (upper.roles[role] - lower.roles[role]) * t,
  ]));
}

export function resolveEffectorCommand(instance: EffectorInstance, command: EffectorCommand): ResolvedEffectorTarget[] {
  if (!instance.available) throw new Error(`EFFECTOR_UNAVAILABLE: ${instance.id}: ${instance.unavailableReason ?? "unavailable"}`);
  if (command.effectorId !== instance.id || command.modelId !== instance.model.modelId || command.modelRevision !== instance.model.revision || command.commandType !== instance.model.commandType) {
    throw new Error(`EFFECTOR_MODEL_MISMATCH: ${command.effectorId}`);
  }
  if (instance.model.commandType !== "aperture_shape") {
    throw new Error(`UNSUPPORTED_EFFECTOR_COMMAND_TYPE: ${instance.model.commandType}`);
  }
  const requestedTorque = command.limits?.maxTorqueNm;
  if (requestedTorque != null) {
    const policy = instance.torqueStop;
    if (!policy || !Number.isFinite(requestedTorque) || requestedTorque < policy.minNm || requestedTorque > policy.maxNm) {
      throw new Error(`EFFECTOR_TORQUE_STOP_OUT_OF_RANGE: ${instance.id}`);
    }
  }
  const apertureVariable = instance.model.variables.aperture;
  const shapeVariable = instance.model.variables.shape;
  if (!apertureVariable || !shapeVariable) throw new Error(`EFFECTOR_COMMAND_VARIABLES_MISSING: ${instance.id}`);
  if (!(shapeVariable.min < 0 && shapeVariable.max > 0)) {
    throw new Error(`EFFECTOR_SHAPE_RANGE_MUST_CROSS_ZERO: ${instance.id}`);
  }
  const aperture = clamp(finite(command.values.aperture, `${instance.id}/aperture`), apertureVariable.min, apertureVariable.max);
  const shape = clamp(finite(command.values.shape, `${instance.id}/shape`), shapeVariable.min, shapeVariable.max);
  const profiles = instance.model.shapeProfiles;
  if (!profiles) throw new Error(`EFFECTOR_SHAPE_PROFILES_MISSING: ${instance.id}`);
  const neutral = interpolateProfile(instance.model, profiles.neutral, aperture);
  const selected = shape < 0 ? profiles.negative : profiles.positive;
  const shaped = interpolateProfile(instance.model, selected, aperture);
  const shapeMagnitude = shape < 0
    ? Math.abs(shape / Math.min(-Number.EPSILON, shapeVariable.min))
    : Math.abs(shape / Math.max(Number.EPSILON, shapeVariable.max));
  return instance.model.drivers.map((driver) => {
    const roleClosure = clamp(
      neutral[driver.role] + (shaped[driver.role] - neutral[driver.role]) * clamp(shapeMagnitude, 0, 1),
      0,
      1,
    );
    return {
      jointName: driver.jointName,
      role: driver.role,
      percent: driver.zeroPercent + roleClosure * (driver.onePercent - driver.zeroPercent),
    };
  });
}

export function createEffectorCommand(
  instance: EffectorInstance,
  values: Record<string, number | boolean | string>,
  options: { maxTorqueNm?: number } = {},
): EffectorCommand {
  return {
    effectorId: instance.id,
    modelId: instance.model.modelId,
    modelRevision: instance.model.revision,
    commandType: instance.model.commandType,
    values,
    ...(options.maxTorqueNm == null ? {} : { limits: { maxTorqueNm: options.maxTorqueNm } }),
  };
}
