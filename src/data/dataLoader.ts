import {
  AmplifiersData,
  EnclosuresData,
  LoadTablesData,
  ValidationError,
  DataLoadResult,
  AmpConfig,
  Amplifier,
  Enclosure,
} from "../types";

// =============================================================================
// Schema Validation
// =============================================================================

function validateAmplifiersSchema(
  data: unknown,
  errors: ValidationError[]
): data is AmplifiersData {
  if (!data || typeof data !== "object") {
    errors.push({
      type: "schema",
      file: "Amplifiers.json",
      message: "File must contain a JSON object",
    });
    return false;
  }

  const obj = data as Record<string, unknown>;

  if (obj.schema !== "amplifiers.v1") {
    errors.push({
      type: "schema",
      file: "Amplifiers.json",
      message: `Invalid schema version: expected "amplifiers.v1", got "${obj.schema}"`,
      path: "schema",
    });
    return false;
  }

  if (!Array.isArray(obj.amplifiers)) {
    errors.push({
      type: "schema",
      file: "Amplifiers.json",
      message: '"amplifiers" must be an array',
      path: "amplifiers",
    });
    return false;
  }

  let valid = true;
  (obj.amplifiers as unknown[]).forEach((amp, index) => {
    if (!amp || typeof amp !== "object") {
      errors.push({
        type: "schema",
        file: "Amplifiers.json",
        message: `Amplifier at index ${index} must be an object`,
        path: `amplifiers[${index}]`,
      });
      valid = false;
      return;
    }

    const ampObj = amp as Record<string, unknown>;
    const requiredFields = ["amplifier", "outputs", "powerRank"];

    for (const field of requiredFields) {
      if (ampObj[field] === undefined) {
        errors.push({
          type: "schema",
          file: "Amplifiers.json",
          message: `Missing required field "${field}"`,
          path: `amplifiers[${index}].${field}`,
        });
        valid = false;
      }
    }

    if (typeof ampObj.amplifier !== "string") {
      errors.push({
        type: "schema",
        file: "Amplifiers.json",
        message: `"amplifier" must be a string`,
        path: `amplifiers[${index}].amplifier`,
      });
      valid = false;
    }

    if (typeof ampObj.outputs !== "number" || ampObj.outputs < 1) {
      errors.push({
        type: "schema",
        file: "Amplifiers.json",
        message: `"outputs" must be a positive number`,
        path: `amplifiers[${index}].outputs`,
      });
      valid = false;
    }

    if (typeof ampObj.powerRank !== "number" || ampObj.powerRank <= 0) {
      errors.push({
        type: "schema",
        file: "Amplifiers.json",
        message: `"powerRank" must be a positive number`,
        path: `amplifiers[${index}].powerRank`,
      });
      valid = false;
    }
  });

  return valid;
}

function validateEnclosuresSchema(
  data: unknown,
  errors: ValidationError[]
): data is EnclosuresData {
  if (!data || typeof data !== "object") {
    errors.push({
      type: "schema",
      file: "Enclosures.json",
      message: "File must contain a JSON object",
    });
    return false;
  }

  const obj = data as Record<string, unknown>;

  if (obj.schema !== "enclosures.v2") {
    errors.push({
      type: "schema",
      file: "Enclosures.json",
      message: `Invalid schema version: expected "enclosures.v2", got "${obj.schema}"`,
      path: "schema",
    });
    return false;
  }

  if (!Array.isArray(obj.enclosures)) {
    errors.push({
      type: "schema",
      file: "Enclosures.json",
      message: '"enclosures" must be an array',
      path: "enclosures",
    });
    return false;
  }

  let valid = true;
  (obj.enclosures as unknown[]).forEach((enc, index) => {
    if (!enc || typeof enc !== "object") {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `Enclosure at index ${index} must be an object`,
        path: `enclosures[${index}]`,
      });
      valid = false;
      return;
    }

    const encObj = enc as Record<string, unknown>;

    if (typeof encObj.enclosure !== "string") {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `"enclosure" must be a string`,
        path: `enclosures[${index}].enclosure`,
      });
      valid = false;
    }

    if (
      !encObj.max_enclosures ||
      typeof encObj.max_enclosures !== "object"
    ) {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `"max_enclosures" must be an object`,
        path: `enclosures[${index}].max_enclosures`,
      });
      valid = false;
    } else {
      // Validate each amp config entry
      const maxEnc = encObj.max_enclosures as Record<string, unknown>;
      for (const [ampKey, limits] of Object.entries(maxEnc)) {
        if (!limits || typeof limits !== "object") {
          errors.push({
            type: "schema",
            file: "Enclosures.json",
            message: `Limits for "${ampKey}" must be an object`,
            path: `enclosures[${index}].max_enclosures.${ampKey}`,
          });
          valid = false;
          continue;
        }

        const limitsObj = limits as Record<string, unknown>;
        if (
          typeof limitsObj.per_output !== "number" ||
          limitsObj.per_output < 1
        ) {
          errors.push({
            type: "schema",
            file: "Enclosures.json",
            message: `"per_output" for "${ampKey}" must be a positive number`,
            path: `enclosures[${index}].max_enclosures.${ampKey}.per_output`,
          });
          valid = false;
        }

        if (
          typeof limitsObj.per_amplifier !== "number" ||
          limitsObj.per_amplifier < 1
        ) {
          errors.push({
            type: "schema",
            file: "Enclosures.json",
            message: `"per_amplifier" for "${ampKey}" must be a positive number`,
            path: `enclosures[${index}].max_enclosures.${ampKey}.per_amplifier`,
          });
          valid = false;
        }
      }
    }

    if (typeof encObj.nominal_impedance_ohms !== "number") {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `"nominal_impedance_ohms" must be a number`,
        path: `enclosures[${index}].nominal_impedance_ohms`,
      });
      valid = false;
    }

    if (!Array.isArray(encObj.signal_channels) || encObj.signal_channels.length === 0) {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `"signal_channels" must be a non-empty array of strings`,
        path: `enclosures[${index}].signal_channels`,
      });
      valid = false;
    }

    if (typeof encObj.parallelAllowed !== "boolean") {
      errors.push({
        type: "schema",
        file: "Enclosures.json",
        message: `"parallelAllowed" must be a boolean`,
        path: `enclosures[${index}].parallelAllowed`,
      });
      valid = false;
    }
  });

  return valid;
}

function validateLoadTablesSchema(
  data: unknown,
  errors: ValidationError[]
): data is LoadTablesData {
  if (!data || typeof data !== "object") {
    errors.push({
      type: "schema",
      file: "Load Tables.json",
      message: "File must contain a JSON object",
    });
    return false;
  }

  const obj = data as Record<string, unknown>;

  if (
    !obj.load_percent_calculator ||
    typeof obj.load_percent_calculator !== "object"
  ) {
    errors.push({
      type: "schema",
      file: "Load Tables.json",
      message: '"load_percent_calculator" must be an object',
      path: "load_percent_calculator",
    });
    return false;
  }

  return true;
}

// =============================================================================
// Cross-Reference Validation
// =============================================================================

/** Map byLoad keys to numeric impedance values */
const BYLOAD_KEY_TO_IMPEDANCE: Record<string, number> = {
  "16_ohm": 16,
  "8_ohm": 8,
  "4_ohm": 4,
  "2_7_ohm": 2.7,
};

function extractRatedImpedances(amp: Amplifier): number[] {
  const rated: number[] = [];
  const byLoad = amp.maxOutputPower_W?.byLoad;
  if (!byLoad) return rated;
  for (const [key, value] of Object.entries(byLoad)) {
    if (value !== null && BYLOAD_KEY_TO_IMPEDANCE[key] !== undefined) {
      rated.push(BYLOAD_KEY_TO_IMPEDANCE[key]);
    }
  }
  return rated;
}

function buildAmpConfigs(amplifiers: Amplifier[]): AmpConfig[] {
  const configs: AmpConfig[] = [];

  for (const amp of amplifiers) {
    const physicalOutputs = amp.physicalOutputs ?? amp.outputs;
    const ratedImpedances = extractRatedImpedances(amp);
    if (amp.operatingModes && amp.operatingModes.length > 0) {
      for (const mode of amp.operatingModes) {
        configs.push({
          key: `${amp.amplifier}_${mode.mode}`,
          model: amp.amplifier,
          mode: mode.mode,
          outputs: amp.outputs,
          physicalOutputs,
          powerRank: amp.powerRank,
          channelTypes: amp.channelTypes,
          channelFillOrder: amp.channelFillOrder,
          ratedImpedances,
        });
      }
    } else {
      configs.push({
        key: amp.amplifier,
        model: amp.amplifier,
        outputs: amp.outputs,
        physicalOutputs,
        powerRank: amp.powerRank,
        channelTypes: amp.channelTypes,
        channelFillOrder: amp.channelFillOrder,
        ratedImpedances,
      });
    }
  }

  return configs;
}

function validateCrossReferences(
  amplifiers: AmplifiersData,
  enclosures: EnclosuresData,
  errors: ValidationError[]
): boolean {
  const ampConfigs = buildAmpConfigs(amplifiers.amplifiers);
  const validAmpConfigKeys = new Set(ampConfigs.map((c) => c.key));

  let valid = true;

  // Check that every amp config key in Enclosures.json references a valid amplifier config
  for (const enclosure of enclosures.enclosures) {
    for (const ampConfigKey of Object.keys(enclosure.max_enclosures)) {
      if (!validAmpConfigKeys.has(ampConfigKey)) {
        errors.push({
          type: "cross-reference",
          file: "Enclosures.json",
          message: `Enclosure "${enclosure.enclosure}" references unknown amp config "${ampConfigKey}". Valid configs: ${Array.from(validAmpConfigKeys).join(", ")}`,
          path: `enclosures[${enclosure.enclosure}].max_enclosures.${ampConfigKey}`,
        });
        valid = false;
      }
    }
  }

  // Check that every amp config has at least one enclosure that supports it
  const usedAmpConfigs = new Set<string>();
  for (const enclosure of enclosures.enclosures) {
    for (const ampConfigKey of Object.keys(enclosure.max_enclosures)) {
      usedAmpConfigs.add(ampConfigKey);
    }
  }

  for (const configKey of validAmpConfigKeys) {
    if (!usedAmpConfigs.has(configKey)) {
      errors.push({
        type: "cross-reference",
        file: "Amplifiers.json",
        message: `Amp config "${configKey}" is defined but not used by any enclosure`,
      });
      // This is a warning, not a failure
    }
  }

  return valid;
}

// =============================================================================
// Data Loading (Main Process)
// =============================================================================

export async function loadDataFromFiles(
  dataPath: string
): Promise<DataLoadResult> {
  const errors: ValidationError[] = [];
  const fs = await import("fs/promises");
  const path = await import("path");

  // Load all JSON files
  let amplifiersRaw: unknown;
  let enclosuresRaw: unknown;
  let loadTablesRaw: unknown;

  try {
    const amplifiersPath = path.join(dataPath, "Amplifiers.json");
    const content = await fs.readFile(amplifiersPath, "utf-8");
    amplifiersRaw = JSON.parse(content);
  } catch (err) {
    errors.push({
      type: "schema",
      file: "Amplifiers.json",
      message: `Failed to load or parse file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const enclosuresPath = path.join(dataPath, "Enclosures.json");
    const content = await fs.readFile(enclosuresPath, "utf-8");
    enclosuresRaw = JSON.parse(content);
  } catch (err) {
    errors.push({
      type: "schema",
      file: "Enclosures.json",
      message: `Failed to load or parse file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const loadTablesPath = path.join(dataPath, "Load Tables.json");
    const content = await fs.readFile(loadTablesPath, "utf-8");
    loadTablesRaw = JSON.parse(content);
  } catch (err) {
    errors.push({
      type: "schema",
      file: "Load Tables.json",
      message: `Failed to load or parse file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // If any file failed to load, return early
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Validate schemas
  const amplifiersValid = validateAmplifiersSchema(amplifiersRaw, errors);
  const enclosuresValid = validateEnclosuresSchema(enclosuresRaw, errors);
  const loadTablesValid = validateLoadTablesSchema(loadTablesRaw, errors);

  if (!amplifiersValid || !enclosuresValid || !loadTablesValid) {
    return { success: false, errors };
  }

  const amplifiers = amplifiersRaw as AmplifiersData;
  const enclosures = enclosuresRaw as EnclosuresData;
  const loadTables = loadTablesRaw as LoadTablesData;

  // Validate cross-references
  const crossRefValid = validateCrossReferences(amplifiers, enclosures, errors);

  if (!crossRefValid) {
    return { success: false, errors };
  }

  // Build normalized amp configs
  const ampConfigs = buildAmpConfigs(amplifiers.amplifiers);

  // Apply defaults to enclosures
  const normalizedEnclosures: EnclosuresData = {
    ...enclosures,
    enclosures: enclosures.enclosures.map((enc) => ({
      ...enc,
      // Default preferredPerOutput to 1 (spread when possible)
      preferredPerOutput: enc.preferredPerOutput ?? 1,
    })),
  };

  return {
    success: true,
    errors,
    data: {
      amplifiers,
      enclosures: normalizedEnclosures,
      loadTables,
      ampConfigs,
    },
  };
}

// =============================================================================
// Helper Functions (for use in renderer)
// =============================================================================

/** Get all compatible amp configs for a given enclosure */
export function getCompatibleAmpConfigs(
  enclosure: Enclosure,
  ampConfigs: AmpConfig[]
): AmpConfig[] {
  const compatibleKeys = new Set(Object.keys(enclosure.max_enclosures));
  return ampConfigs.filter((config) => compatibleKeys.has(config.key));
}

/** Get the limits for a specific enclosure/amp combination */
export function getEnclosureLimits(
  enclosure: Enclosure,
  ampConfigKey: string
): { per_output: number; per_amplifier: number } | null {
  return enclosure.max_enclosures[ampConfigKey] || null;
}

/** Calculate load percentage */
export function computeLoadPercent(
  countOnAmp: number,
  perAmplifierLimit: number
): number {
  return Math.round((countOnAmp / perAmplifierLimit) * 100 * 100) / 100;
}

/** Calculate impedance when enclosures are in parallel */
export function computeParallelImpedance(
  nominalImpedance: number,
  parallelCount: number
): number {
  return Math.round((nominalImpedance / parallelCount) * 10) / 10;
}
