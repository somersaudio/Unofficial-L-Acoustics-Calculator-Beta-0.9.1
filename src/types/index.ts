// =============================================================================
// Amplifier Types
// =============================================================================

export interface OperatingMode {
  mode: string; // e.g., "SE", "BTL", "PBTL"
  description: string;
}

export interface MaxOutputPower {
  byLoad: {
    "16_ohm": string | null;
    "8_ohm": string | null;
    "4_ohm": string | null;
    "2_7_ohm": string | null;
  };
}

/** Channel type configuration for multi-channel amps like LA7.16(i) */
export interface ChannelTypes {
  pattern: string[]; // Repeating pattern, e.g., ["LC", "LF", "HF", "HF"]
  nominalImpedance: Record<string, number>; // e.g., { "LC": 8, "LF": 8, "HF": 8 }
}

export interface Amplifier {
  amplifier: string; // Model name, e.g., "LA12X"
  outputs: number; // Number of amp channels (used by solver for allocation)
  physicalOutputs?: number; // Number of physical connectors on rear panel (for UI grouping; defaults to outputs)
  powerRank: number; // 1 = lowest power, 4 = highest
  operatingModes: OperatingMode[];
  maxOutputPower_W: MaxOutputPower;
  channelTypes?: ChannelTypes; // Optional: for multi-channel amps like LA7.16(i)
  channelFillOrder?: number[]; // Optional: custom output fill order (0-indexed), e.g., [0, 2, 1, 3] for LA4X
}

export interface AmplifiersData {
  schema: "amplifiers.v1";
  amplifiers: Amplifier[];
}

// =============================================================================
// Enclosure Types
// =============================================================================

export interface EnclosureLimits {
  per_output: number; // Max enclosures per single amp output
  per_amplifier: number; // Max enclosures per entire amplifier
  min_impedance_override?: number; // Optional: allows impedance below normal minimum for this amp/enclosure combo
}

/** Keys like "LA12X", "LA7.16(i)", "LA4X", "LA2Xi_SE", "LA2Xi_BTL", "LA2Xi_PBTL" */
export type AmpConfigKey = string;

export interface Enclosure {
  enclosure: string; // Model name, e.g., "K1", "Kara II(i)"
  max_enclosures: Record<AmpConfigKey, EnclosureLimits>;
  nominal_impedance_ohms: number; // 4, 8, or 16
  parallelAllowed: boolean;
  preferredPerOutput: number; // Preferred count per output when spreading (default: 1)
  signal_channels: string[]; // Ordered amp channels needed: ["PA"], ["LF","HF"], ["LF","LF","MF","HF"], ["SB"], etc.
  impedance_sections_ohms?: Record<string, number>; // Optional, e.g., { "HF": 16 }
  impedance_notes?: string;
  parallel_notes?: string;
  notes?: string[];
}

export interface EnclosuresData {
  schema: "enclosures.v2";
  enclosures: Enclosure[];
}

// =============================================================================
// Load Tables Types
// =============================================================================

export interface LoadTableFunction {
  inputs: string[];
  steps: string[];
}

export interface LoadPercentCalculator {
  definition: string;
  functions: {
    getPerAmplifierLimit: LoadTableFunction;
    computeLoadPercent: LoadTableFunction;
    computePerEnclosurePercent: LoadTableFunction;
  };
}

export interface LoadTablesData {
  load_percent_calculator: LoadPercentCalculator;
}

// =============================================================================
// Normalized / Resolved Types (for runtime use)
// =============================================================================

/** Represents an amp configuration (model + optional mode) */
export interface AmpConfig {
  key: AmpConfigKey; // e.g., "LA12X" or "LA2Xi_SE"
  model: string; // Base model name, e.g., "LA12X" or "LA2Xi"
  mode?: string; // Optional mode for LA2Xi: "SE", "BTL", or "PBTL"
  outputs: number; // Number of amp channels (solver uses this)
  physicalOutputs: number; // Number of physical connectors (UI uses this for grouping)
  powerRank: number;
  channelTypes?: ChannelTypes; // Optional: for multi-channel amps like LA7.16(i)
  channelFillOrder?: number[]; // Optional: custom output fill order (0-indexed)
  ratedImpedances: number[]; // Impedances where byLoad is non-null (e.g., [8, 4, 2.7] for LA12X)
}

/** Validation error structure */
export interface ValidationError {
  type: "schema" | "cross-reference" | "data";
  file: string;
  message: string;
  path?: string; // JSON path to the error, e.g., "amplifiers[0].outputs"
}

/** Result of loading and validating all data */
export interface DataLoadResult {
  success: boolean;
  errors: ValidationError[];
  data?: {
    amplifiers: AmplifiersData;
    enclosures: EnclosuresData;
    loadTables: LoadTablesData;
    ampConfigs: AmpConfig[]; // Normalized list of all amp configurations
  };
}

// =============================================================================
// Solver Types (Phase 2)
// =============================================================================

/** User's request for enclosures to power */
export interface EnclosureRequest {
  enclosure: Enclosure;
  quantity: number;
}

/** Allocation of enclosures to a single amplifier output */
export interface OutputAllocation {
  outputIndex: number; // 0-based output number
  enclosures: Array<{
    enclosure: Enclosure;
    count: number;
  }>;
  totalEnclosures: number;
  impedanceOhms: number; // Calculated impedance for this output
  minImpedanceOverride?: number; // Optional: manufacturer-allowed minimum impedance for this output
}

/** A single amplifier instance with its output allocations */
export interface AmpInstance {
  id: string; // Unique ID like "LA12X-1", "LA12X-2"
  ampConfig: AmpConfig;
  outputs: OutputAllocation[];
  totalEnclosures: number;
  loadPercent: number; // How much of the amp's capacity is used
}

/** Complete solution from the solver */
export interface SolverSolution {
  success: boolean;
  errorMessage?: string;
  ampInstances: AmpInstance[];
  summary: {
    totalAmplifiers: number;
    totalEnclosuresAllocated: number;
    ampConfigsUsed: AmpConfig[];
    maxPowerRank: number;
  };
}

/** Represents a candidate solution during solving */
export interface SolverCandidate {
  ampConfigKey: AmpConfigKey;
  ampConfig: AmpConfig;
  perOutput: number; // Max enclosures per output for this enclosure/amp combo
  perAmplifier: number; // Max enclosures per amplifier
  enclosuresPerAmp: number; // Actual enclosures this amp can handle
  minImpedanceOverride?: number; // Optional: manufacturer-allowed minimum impedance for this combo
}

// =============================================================================
// Phase 3 Types
// =============================================================================

/** Minimum allowed impedance (2.7 ohms with tolerance) */
export const MIN_IMPEDANCE_OHMS = 2.7;
export const IMPEDANCE_TOLERANCE = 0.15;
export const HARD_FLOOR_IMPEDANCE = MIN_IMPEDANCE_OHMS - IMPEDANCE_TOLERANCE; // 2.55

// =============================================================================
// Cable Length Reference (from LA01205 v13.0, p.9)
// =============================================================================

export interface CableGaugeSpec {
  mm2: number;
  swg: number;
  awg: number;
}

export interface CableLengthLimit {
  meters: number | null; // null = not rated for this impedance
  feet: number | null;
}

/** Impedance thresholds for cable length lookup (use the bracket at or below the actual impedance) */
export const CABLE_IMPEDANCE_THRESHOLDS = [8, 4, 2.7] as const;

/** Cable gauges available */
export const CABLE_GAUGES: CableGaugeSpec[] = [
  { mm2: 1.5, swg: 18, awg: 16 },
  { mm2: 2.5, swg: 15, awg: 14 },
  { mm2: 4, swg: 13, awg: 11 },
  { mm2: 6, swg: 11, awg: 9 },
];

/**
 * Recommended maximum cable length by gauge and impedance load.
 * Key: mm² gauge. Value: { 8: limit, 4: limit, 2.7: limit }
 * Source: L-Acoustics Amplification Reference v13.0, p.9
 */
export const CABLE_LENGTH_TABLE: Record<number, Record<number, CableLengthLimit>> = {
  1.5: {
    8:   { meters: 18, feet: 60 },
    4:   { meters: 9, feet: 30 },
    2.7: { meters: null, feet: null },
  },
  2.5: {
    8:   { meters: 30, feet: 100 },
    4:   { meters: 15, feet: 50 },
    2.7: { meters: 10, feet: 33 },
  },
  4: {
    8:   { meters: 50, feet: 160 },
    4:   { meters: 25, feet: 80 },
    2.7: { meters: 17, feet: 53 },
  },
  6: {
    8:   { meters: 74, feet: 240 },
    4:   { meters: 37, feet: 120 },
    2.7: { meters: 25, feet: 80 },
  },
};

/**
 * Get the max cable length for a given impedance and cable gauge.
 * Uses the impedance bracket at or below the actual impedance (conservative).
 * Returns null if impedance is too low or infinite (no load).
 */
export function getMaxCableLength(impedanceOhms: number, gaugeMm2: number): CableLengthLimit | null {
  if (impedanceOhms === Infinity || impedanceOhms <= 0) return null;

  const gaugeTable = CABLE_LENGTH_TABLE[gaugeMm2];
  if (!gaugeTable) return null;

  // Find the appropriate impedance bracket (highest threshold that is <= actual impedance)
  for (const threshold of CABLE_IMPEDANCE_THRESHOLDS) {
    if (impedanceOhms >= threshold) {
      return gaugeTable[threshold] ?? null;
    }
  }

  // Below 2.7Ω — not rated
  return { meters: null, feet: null };
}

/** Impedance validation result for an output */
export interface ImpedanceValidation {
  impedanceOhms: number;
  isValid: boolean; // true if >= HARD_FLOOR_IMPEDANCE
  isBelowMinimum: boolean; // true if < MIN_IMPEDANCE_OHMS (error state)
}

/** Enclosure compatibility info for UI display */
export interface EnclosureCompatibility {
  enclosure: Enclosure;
  compatibleAmpConfigs: AmpConfig[];
  isLimitedCompatibility: boolean; // true if only 1 amp config works
  autoSelectedAmp: AmpConfig | null; // non-null if only 1 option
}

/** User's amplifier inventory - how many of each amp model they own */
export type AmpInventory = Record<string, number>; // model name -> quantity (0 = disabled)

// =============================================================================
// Zone Types
// =============================================================================

/** A zone represents an isolated allocation group with its own enclosures and amp toggles */
export interface Zone {
  id: string;
  name: string;
  requests: EnclosureRequest[];
  disabledAmps: Set<string>;
}

/** Zone paired with its computed solver result */
export interface ZoneWithSolution {
  zone: Zone;
  solution: SolverSolution | null;
  enabledAmpConfigs: AmpConfig[];
}

/** Serializable form of a Zone for JSON persistence */
export interface ZoneSerialized {
  id: string;
  name: string;
  requests: Array<{ enclosureName: string; quantity: number }>;
  disabledAmps: string[];
}

/** Project file format for save/load */
export interface ProjectFile {
  version: 1;
  zones: ZoneSerialized[];
  settings: {
    darkMode: boolean;
    salesMode: boolean;
    cableGaugeMm2: number;
    useFeet: boolean;
  };
}
