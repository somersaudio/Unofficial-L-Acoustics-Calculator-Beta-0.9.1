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

export interface Amplifier {
  amplifier: string; // Model name, e.g., "LA12X"
  outputs: number; // Number of physical outputs
  powerRank: number; // 1 = lowest power, 4 = highest
  operatingModes: OperatingMode[];
  maxOutputPower_W: MaxOutputPower;
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

/** Keys like "LA12X", "LA7.16i", "LA4X", "LA2Xi_SE", "LA2Xi_BTL", "LA2Xi_PBTL" */
export type AmpConfigKey = string;

export interface Enclosure {
  enclosure: string; // Model name, e.g., "K1", "Kara II(i)"
  max_enclosures: Record<AmpConfigKey, EnclosureLimits>;
  nominal_impedance_ohms: number; // 4, 8, or 16
  parallelAllowed: boolean;
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
  outputs: number;
  powerRank: number;
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
