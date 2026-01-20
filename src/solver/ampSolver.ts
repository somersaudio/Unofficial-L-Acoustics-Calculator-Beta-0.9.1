import {
  Enclosure,
  EnclosureRequest,
  AmpConfig,
  AmpInstance,
  OutputAllocation,
  SolverSolution,
  SolverCandidate,
  EnclosureCompatibility,
  ImpedanceValidation,
  HARD_FLOOR_IMPEDANCE,
  MIN_IMPEDANCE_OHMS,
} from "../types";

// =============================================================================
// Helper Functions
// =============================================================================

/** Calculate impedance when enclosures are wired in parallel */
function calculateParallelImpedance(
  nominalImpedance: number,
  count: number
): number {
  if (count <= 0) return Infinity;
  if (count === 1) return nominalImpedance;
  // Parallel impedance: Z_total = Z / n
  return Math.round((nominalImpedance / count) * 10) / 10;
}

/** Generate a unique ID for an amp instance */
function generateAmpId(ampConfigKey: string, index: number): string {
  return `${ampConfigKey}-${index + 1}`;
}

/** Get compatible amp configs for an enclosure, sorted by powerRank (lowest first) */
function getCompatibleConfigs(
  enclosure: Enclosure,
  allAmpConfigs: AmpConfig[]
): SolverCandidate[] {
  const candidates: SolverCandidate[] = [];

  for (const ampConfig of allAmpConfigs) {
    const limits = enclosure.max_enclosures[ampConfig.key];
    if (!limits) continue;

    candidates.push({
      ampConfigKey: ampConfig.key,
      ampConfig,
      perOutput: limits.per_output,
      perAmplifier: limits.per_amplifier,
      enclosuresPerAmp: limits.per_amplifier,
      minImpedanceOverride: limits.min_impedance_override,
    });
  }

  // Sort by powerRank (lowest first), then by enclosuresPerAmp (highest first for tie-breaking)
  candidates.sort((a, b) => {
    if (a.ampConfig.powerRank !== b.ampConfig.powerRank) {
      return a.ampConfig.powerRank - b.ampConfig.powerRank;
    }
    return b.enclosuresPerAmp - a.enclosuresPerAmp;
  });

  return candidates;
}

/** Find the best amp config that can handle a given enclosure type */
function findBestAmpConfig(
  enclosure: Enclosure,
  quantity: number,
  allAmpConfigs: AmpConfig[]
): SolverCandidate | null {
  const candidates = getCompatibleConfigs(enclosure, allAmpConfigs);

  // Find the lowest power amp that can handle the quantity with minimum amp count
  let bestCandidate: SolverCandidate | null = null;
  let bestAmpCount = Infinity;

  for (const candidate of candidates) {
    const ampCount = Math.ceil(quantity / candidate.enclosuresPerAmp);

    // Prefer fewer amps, then lower power
    if (ampCount < bestAmpCount) {
      bestAmpCount = ampCount;
      bestCandidate = candidate;
    } else if (ampCount === bestAmpCount && bestCandidate) {
      // Same amp count, prefer lower power
      if (candidate.ampConfig.powerRank < bestCandidate.ampConfig.powerRank) {
        bestCandidate = candidate;
      }
    }
  }

  return bestCandidate;
}

// =============================================================================
// Output Allocation Logic
// =============================================================================

/**
 * Allocate enclosures to outputs on a single amp.
 * - If parallelAllowed: fill each output to max before moving to next
 * - If not parallelAllowed: spread 1 per output
 */
function allocateToOutputs(
  enclosure: Enclosure,
  count: number,
  ampConfig: AmpConfig,
  limits: { perOutput: number; perAmplifier: number; minImpedanceOverride?: number }
): OutputAllocation[] {
  const outputs: OutputAllocation[] = [];
  let remaining = count;

  // Initialize all outputs
  for (let i = 0; i < ampConfig.outputs; i++) {
    outputs.push({
      outputIndex: i,
      enclosures: [],
      totalEnclosures: 0,
      impedanceOhms: Infinity, // No load = infinite impedance
    });
  }

  if (enclosure.parallelAllowed) {
    // Fill each output to max before moving to next
    let outputIdx = 0;
    while (remaining > 0 && outputIdx < ampConfig.outputs) {
      const toAllocate = Math.min(remaining, limits.perOutput);
      outputs[outputIdx].enclosures.push({
        enclosure,
        count: toAllocate,
      });
      outputs[outputIdx].totalEnclosures = toAllocate;
      outputs[outputIdx].impedanceOhms = calculateParallelImpedance(
        enclosure.nominal_impedance_ohms,
        toAllocate
      );
      // Set impedance override if manufacturer allows lower impedance
      if (limits.minImpedanceOverride !== undefined) {
        outputs[outputIdx].minImpedanceOverride = limits.minImpedanceOverride;
      }
      remaining -= toAllocate;
      outputIdx++;
    }
  } else {
    // Spread 1 per output (no parallel)
    let outputIdx = 0;
    while (remaining > 0 && outputIdx < ampConfig.outputs) {
      outputs[outputIdx].enclosures.push({
        enclosure,
        count: 1,
      });
      outputs[outputIdx].totalEnclosures = 1;
      outputs[outputIdx].impedanceOhms = enclosure.nominal_impedance_ohms;
      // Set impedance override if manufacturer allows lower impedance
      if (limits.minImpedanceOverride !== undefined) {
        outputs[outputIdx].minImpedanceOverride = limits.minImpedanceOverride;
      }
      remaining--;
      outputIdx++;
    }
  }

  return outputs;
}

/**
 * Merge additional enclosures into existing output allocations.
 * Used when multiple enclosure types are allocated to the same amp.
 * IMPORTANT: Only uses empty outputs - never mixes different enclosure types on the same output.
 */
function mergeIntoOutputs(
  existingOutputs: OutputAllocation[],
  enclosure: Enclosure,
  count: number,
  limits: { perOutput: number; perAmplifier: number; minImpedanceOverride?: number }
): { outputs: OutputAllocation[]; allocated: number } {
  let remaining = count;
  const outputs = existingOutputs.map((o) => ({ ...o, enclosures: [...o.enclosures] }));

  if (enclosure.parallelAllowed) {
    // Only add to EMPTY outputs - never mix enclosure types on the same output
    for (let i = 0; i < outputs.length && remaining > 0; i++) {
      // Skip outputs that already have enclosures
      if (outputs[i].totalEnclosures > 0) continue;

      const toAllocate = Math.min(remaining, limits.perOutput);
      outputs[i].enclosures.push({ enclosure, count: toAllocate });
      outputs[i].totalEnclosures = toAllocate;
      outputs[i].impedanceOhms = calculateParallelImpedance(
        enclosure.nominal_impedance_ohms,
        toAllocate
      );
      // Set impedance override if manufacturer allows lower impedance
      if (limits.minImpedanceOverride !== undefined) {
        outputs[i].minImpedanceOverride = limits.minImpedanceOverride;
      }
      remaining -= toAllocate;
    }
  } else {
    // No parallel - only add to empty outputs, 1 per output
    for (let i = 0; i < outputs.length && remaining > 0; i++) {
      if (outputs[i].totalEnclosures === 0) {
        outputs[i].enclosures.push({ enclosure, count: 1 });
        outputs[i].totalEnclosures = 1;
        outputs[i].impedanceOhms = enclosure.nominal_impedance_ohms;
        // Set impedance override if manufacturer allows lower impedance
        if (limits.minImpedanceOverride !== undefined) {
          outputs[i].minImpedanceOverride = limits.minImpedanceOverride;
        }
        remaining--;
      }
    }
  }

  return { outputs, allocated: count - remaining };
}

/** Calculate total impedance for an output with potentially mixed enclosures */
function calculateOutputImpedance(output: OutputAllocation): number {
  if (output.enclosures.length === 0) return Infinity;

  // For simplicity, if all enclosures are the same type, use parallel formula
  // For mixed types, we'd need more complex impedance calculation
  // For now, calculate as if all are in parallel
  let totalInverseImpedance = 0;

  for (const entry of output.enclosures) {
    for (let i = 0; i < entry.count; i++) {
      totalInverseImpedance += 1 / entry.enclosure.nominal_impedance_ohms;
    }
  }

  if (totalInverseImpedance === 0) return Infinity;
  return Math.round((1 / totalInverseImpedance) * 10) / 10;
}

// =============================================================================
// Main Solver
// =============================================================================

/**
 * Solve for the optimal amplifier configuration.
 *
 * Algorithm:
 * 1. For each enclosure type, find compatible amps
 * 2. Group enclosures that share common compatible amps
 * 3. Find the combination that minimizes:
 *    a. Total amplifier count (primary)
 *    b. Maximum power rank used (secondary)
 *    c. Sum of power ranks (tertiary)
 */
export function solveAmplifierAllocation(
  requests: EnclosureRequest[],
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  if (requests.length === 0) {
    return {
      success: false,
      errorMessage: "No enclosures requested",
      ampInstances: [],
      summary: {
        totalAmplifiers: 0,
        totalEnclosuresAllocated: 0,
        ampConfigsUsed: [],
        maxPowerRank: 0,
      },
    };
  }

  // Filter out zero-quantity requests
  const validRequests = requests.filter((r) => r.quantity > 0);
  if (validRequests.length === 0) {
    return {
      success: false,
      errorMessage: "All enclosure quantities are zero",
      ampInstances: [],
      summary: {
        totalAmplifiers: 0,
        totalEnclosuresAllocated: 0,
        ampConfigsUsed: [],
        maxPowerRank: 0,
      },
    };
  }

  // For single enclosure type, use simple allocation
  if (validRequests.length === 1) {
    return solveSingleEnclosureType(validRequests[0], allAmpConfigs);
  }

  // For multiple enclosure types, use multi-type solver
  return solveMultipleEnclosureTypes(validRequests, allAmpConfigs);
}

/** Solve for a single enclosure type */
function solveSingleEnclosureType(
  request: EnclosureRequest,
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  const { enclosure, quantity } = request;

  const bestCandidate = findBestAmpConfig(enclosure, quantity, allAmpConfigs);

  if (!bestCandidate) {
    return {
      success: false,
      errorMessage: `No compatible amplifier found for ${enclosure.enclosure}`,
      ampInstances: [],
      summary: {
        totalAmplifiers: 0,
        totalEnclosuresAllocated: 0,
        ampConfigsUsed: [],
        maxPowerRank: 0,
      },
    };
  }

  const ampInstances: AmpInstance[] = [];
  let remaining = quantity;
  let ampIndex = 0;

  while (remaining > 0) {
    const toAllocate = Math.min(remaining, bestCandidate.enclosuresPerAmp);
    const outputs = allocateToOutputs(
      enclosure,
      toAllocate,
      bestCandidate.ampConfig,
      { perOutput: bestCandidate.perOutput, perAmplifier: bestCandidate.perAmplifier, minImpedanceOverride: bestCandidate.minImpedanceOverride }
    );

    const ampInstance: AmpInstance = {
      id: generateAmpId(bestCandidate.ampConfigKey, ampIndex),
      ampConfig: bestCandidate.ampConfig,
      outputs,
      totalEnclosures: toAllocate,
      loadPercent: Math.round((toAllocate / bestCandidate.perAmplifier) * 100),
    };

    ampInstances.push(ampInstance);
    remaining -= toAllocate;
    ampIndex++;
  }

  return {
    success: true,
    ampInstances,
    summary: {
      totalAmplifiers: ampInstances.length,
      totalEnclosuresAllocated: quantity,
      ampConfigsUsed: [bestCandidate.ampConfig],
      maxPowerRank: bestCandidate.ampConfig.powerRank,
    },
  };
}

/** Find amp configs that are compatible with ALL given enclosures */
function findCommonCompatibleConfigs(
  requests: EnclosureRequest[],
  allAmpConfigs: AmpConfig[]
): AmpConfig[] {
  if (requests.length === 0) return [];

  // Start with configs compatible with first enclosure
  let commonConfigs = new Set(
    getCompatibleConfigs(requests[0].enclosure, allAmpConfigs).map((c) => c.ampConfigKey)
  );

  // Intersect with configs compatible with each subsequent enclosure
  for (let i = 1; i < requests.length; i++) {
    const compatibleKeys = new Set(
      getCompatibleConfigs(requests[i].enclosure, allAmpConfigs).map((c) => c.ampConfigKey)
    );
    commonConfigs = new Set([...commonConfigs].filter((key) => compatibleKeys.has(key)));
  }

  return allAmpConfigs.filter((c) => commonConfigs.has(c.key));
}

/** Calculate total outputs needed across all enclosure types */
function calculateTotalOutputsNeeded(
  requests: EnclosureRequest[],
  ampConfig: AmpConfig,
  allAmpConfigs: AmpConfig[]
): number {
  let totalOutputs = 0;

  for (const request of requests) {
    const candidates = getCompatibleConfigs(request.enclosure, allAmpConfigs);
    const candidate = candidates.find((c) => c.ampConfigKey === ampConfig.key);
    if (!candidate) return Infinity; // Not compatible

    // Calculate outputs needed for this enclosure type
    const outputsNeeded = Math.ceil(request.quantity / candidate.perOutput);
    totalOutputs += outputsNeeded;
  }

  return totalOutputs;
}

/** Solve for multiple enclosure types - tries to share amps between compatible types */
function solveMultipleEnclosureTypes(
  requests: EnclosureRequest[],
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  // Strategy: Find the most efficient amp configuration for all enclosures together
  // 1. Find amp configs compatible with ALL enclosure types
  // 2. If found, evaluate if using shared amps is more efficient
  // 3. Otherwise, solve each type independently

  const totalEnclosures = requests.reduce((sum, r) => sum + r.quantity, 0);

  // Find amp configs that work for ALL enclosure types
  const commonConfigs = findCommonCompatibleConfigs(requests, allAmpConfigs);

  // Evaluate the best shared solution
  let bestSharedSolution: {
    ampConfig: AmpConfig;
    ampsNeeded: number;
    outputsNeeded: number;
  } | null = null;

  for (const ampConfig of commonConfigs) {
    const outputsNeeded = calculateTotalOutputsNeeded(requests, ampConfig, allAmpConfigs);
    const ampsNeeded = Math.ceil(outputsNeeded / ampConfig.outputs);

    if (
      !bestSharedSolution ||
      ampsNeeded < bestSharedSolution.ampsNeeded ||
      (ampsNeeded === bestSharedSolution.ampsNeeded &&
        ampConfig.powerRank < bestSharedSolution.ampConfig.powerRank)
    ) {
      bestSharedSolution = { ampConfig, ampsNeeded, outputsNeeded };
    }
  }

  // Calculate what independent solving would give us
  let independentAmpsNeeded = 0;
  for (const request of requests) {
    const best = findBestAmpConfig(request.enclosure, request.quantity, allAmpConfigs);
    if (best) {
      independentAmpsNeeded += Math.ceil(request.quantity / best.enclosuresPerAmp);
    }
  }

  // Use shared solution if it's better or equal (prefer consolidation)
  if (bestSharedSolution && bestSharedSolution.ampsNeeded <= independentAmpsNeeded) {
    return buildSharedSolution(requests, bestSharedSolution.ampConfig, allAmpConfigs);
  }

  // Fall back to independent solving
  return solveIndependently(requests, allAmpConfigs);
}

/** Build a solution using a shared amp config for all enclosure types */
function buildSharedSolution(
  requests: EnclosureRequest[],
  ampConfig: AmpConfig,
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  const ampInstances: AmpInstance[] = [];
  let totalAllocated = 0;

  // Process each request, filling amps and creating new ones as needed
  for (const request of requests) {
    const { enclosure, quantity } = request;
    let remaining = quantity;

    // Get the limits for this enclosure on the chosen amp
    const candidates = getCompatibleConfigs(enclosure, allAmpConfigs);
    const candidate = candidates.find((c) => c.ampConfigKey === ampConfig.key);
    if (!candidate) continue;

    // Try to fill existing amps first (only empty outputs)
    for (const ampInstance of ampInstances) {
      if (remaining <= 0) break;

      const { outputs, allocated } = mergeIntoOutputs(
        ampInstance.outputs,
        enclosure,
        remaining,
        { perOutput: candidate.perOutput, perAmplifier: candidate.perAmplifier, minImpedanceOverride: candidate.minImpedanceOverride }
      );

      if (allocated > 0) {
        ampInstance.outputs = outputs;
        ampInstance.totalEnclosures += allocated;
        // Recalculate load percent based on outputs used
        const usedOutputs = ampInstance.outputs.filter((o) => o.totalEnclosures > 0).length;
        ampInstance.loadPercent = Math.round((usedOutputs / ampConfig.outputs) * 100);
        remaining -= allocated;
      }
    }

    // Create new amps for remaining
    while (remaining > 0) {
      const toAllocate = Math.min(remaining, candidate.perAmplifier);
      const outputs = allocateToOutputs(enclosure, toAllocate, ampConfig, {
        perOutput: candidate.perOutput,
        perAmplifier: candidate.perAmplifier,
        minImpedanceOverride: candidate.minImpedanceOverride,
      });

      const ampIndex = ampInstances.filter((i) => i.ampConfig.key === ampConfig.key).length;

      ampInstances.push({
        id: generateAmpId(ampConfig.key, ampIndex),
        ampConfig,
        outputs,
        totalEnclosures: toAllocate,
        loadPercent: Math.round(
          (outputs.filter((o) => o.totalEnclosures > 0).length / ampConfig.outputs) * 100
        ),
      });

      remaining -= toAllocate;
    }

    totalAllocated += quantity;
  }

  return {
    success: true,
    ampInstances,
    summary: {
      totalAmplifiers: ampInstances.length,
      totalEnclosuresAllocated: totalAllocated,
      ampConfigsUsed: [ampConfig],
      maxPowerRank: ampConfig.powerRank,
    },
  };
}

/** Solve each enclosure type independently (original behavior) */
function solveIndependently(
  requests: EnclosureRequest[],
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  const allInstances: AmpInstance[] = [];
  const configsUsed = new Set<string>();
  let totalAllocated = 0;
  let maxPowerRank = 0;

  for (const request of requests) {
    const result = solveSingleEnclosureType(request, allAmpConfigs);

    if (!result.success) {
      return result;
    }

    // Renumber amp instances to avoid ID collisions
    for (const instance of result.ampInstances) {
      const ampIndex = allInstances.filter(
        (i) => i.ampConfig.key === instance.ampConfig.key
      ).length;
      const newId = generateAmpId(instance.ampConfig.key, ampIndex);
      allInstances.push({ ...instance, id: newId });
    }

    for (const config of result.summary.ampConfigsUsed) {
      configsUsed.add(config.key);
    }
    totalAllocated += result.summary.totalEnclosuresAllocated;
    maxPowerRank = Math.max(maxPowerRank, result.summary.maxPowerRank);
  }

  const ampConfigsUsed = allAmpConfigs.filter((c) => configsUsed.has(c.key));

  return {
    success: true,
    ampInstances: allInstances,
    summary: {
      totalAmplifiers: allInstances.length,
      totalEnclosuresAllocated: totalAllocated,
      ampConfigsUsed,
      maxPowerRank,
    },
  };
}

// =============================================================================
// Impedance Validation
// =============================================================================

/** Validate impedance for an output */
export function validateImpedance(impedanceOhms: number): ImpedanceValidation {
  return {
    impedanceOhms,
    isValid: impedanceOhms >= HARD_FLOOR_IMPEDANCE || impedanceOhms === Infinity,
    isBelowMinimum: impedanceOhms < MIN_IMPEDANCE_OHMS && impedanceOhms !== Infinity,
  };
}

/** Check if any output in the solution has invalid impedance */
export function hasImpedanceErrors(solution: SolverSolution): boolean {
  if (!solution.success) return false;

  for (const amp of solution.ampInstances) {
    for (const output of amp.outputs) {
      if (output.impedanceOhms === Infinity) continue;

      // Use the output's impedance override if set, otherwise use the global floor
      const minAllowed = output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
      if (output.impedanceOhms < minAllowed) {
        return true;
      }
    }
  }
  return false;
}

/** Get all impedance errors from a solution */
export function getImpedanceErrors(solution: SolverSolution): Array<{
  ampId: string;
  outputIndex: number;
  impedanceOhms: number;
}> {
  const errors: Array<{
    ampId: string;
    outputIndex: number;
    impedanceOhms: number;
  }> = [];

  if (!solution.success) return errors;

  for (const amp of solution.ampInstances) {
    for (const output of amp.outputs) {
      if (output.impedanceOhms === Infinity) continue;

      // Use the output's impedance override if set, otherwise use the global floor
      const minAllowed = output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
      if (output.impedanceOhms < minAllowed) {
        errors.push({
          ampId: amp.id,
          outputIndex: output.outputIndex,
          impedanceOhms: output.impedanceOhms,
        });
      }
    }
  }
  return errors;
}

// =============================================================================
// Compatibility Checking
// =============================================================================

/** Get compatibility info for an enclosure */
export function getEnclosureCompatibility(
  enclosure: Enclosure,
  allAmpConfigs: AmpConfig[]
): EnclosureCompatibility {
  const compatibleConfigs = getCompatibleConfigs(enclosure, allAmpConfigs)
    .map(c => c.ampConfig);

  const isLimited = compatibleConfigs.length === 1;

  return {
    enclosure,
    compatibleAmpConfigs: compatibleConfigs,
    isLimitedCompatibility: isLimited,
    autoSelectedAmp: isLimited ? compatibleConfigs[0] : null,
  };
}

/** Get compatibility info for all enclosures */
export function getAllEnclosureCompatibility(
  enclosures: Enclosure[],
  allAmpConfigs: AmpConfig[]
): EnclosureCompatibility[] {
  return enclosures.map(enc => getEnclosureCompatibility(enc, allAmpConfigs));
}

// =============================================================================
// Utility Exports
// =============================================================================

export { calculateParallelImpedance, getCompatibleConfigs };
