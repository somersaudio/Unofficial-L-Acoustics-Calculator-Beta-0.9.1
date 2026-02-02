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
// Constants
// =============================================================================

// Maximum number of different enclosure types allowed per amplifier
const MAX_ENCLOSURE_TYPES_PER_AMP = 3;

// =============================================================================
// Helper Functions
// =============================================================================

/** Count the number of unique enclosure types on an amp's outputs */
function countEnclosureTypesOnAmp(outputs: OutputAllocation[]): number {
  const types = new Set<string>();
  for (const output of outputs) {
    for (const entry of output.enclosures) {
      types.add(entry.enclosure.enclosure);
    }
  }
  return types.size;
}

/** Check if an enclosure type is already on the amp */
function isEnclosureTypeOnAmp(outputs: OutputAllocation[], enclosureName: string): boolean {
  for (const output of outputs) {
    for (const entry of output.enclosures) {
      if (entry.enclosure.enclosure === enclosureName) {
        return true;
      }
    }
  }
  return false;
}

/** Get all unique enclosure types from outputs */
function getEnclosureTypesFromOutputs(outputs: OutputAllocation[]): Enclosure[] {
  const seen = new Set<string>();
  const enclosures: Enclosure[] = [];
  for (const output of outputs) {
    for (const entry of output.enclosures) {
      if (!seen.has(entry.enclosure.enclosure)) {
        seen.add(entry.enclosure.enclosure);
        enclosures.push(entry.enclosure);
      }
    }
  }
  return enclosures;
}

/** Count total used outputs (outputs with enclosures) */
function countUsedOutputs(outputs: OutputAllocation[]): number {
  return outputs.filter(o => o.totalEnclosures > 0).length;
}

/**
 * Consolidate enclosures on an amp to free up outputs.
 * This packs enclosures of the same type more tightly (up to perOutput limits)
 * to create empty outputs for new enclosure types.
 *
 * Returns a new outputs array with enclosures consolidated, or null if consolidation isn't possible.
 */
function consolidateOutputs(
  outputs: OutputAllocation[],
  ampConfigKey: string,
  allAmpConfigs: AmpConfig[]
): OutputAllocation[] | null {
  // Group enclosures by type
  const enclosuresByType = new Map<string, { enclosure: Enclosure; totalCount: number }>();

  for (const output of outputs) {
    for (const entry of output.enclosures) {
      const key = entry.enclosure.enclosure;
      const existing = enclosuresByType.get(key);
      if (existing) {
        existing.totalCount += entry.count;
      } else {
        enclosuresByType.set(key, { enclosure: entry.enclosure, totalCount: entry.count });
      }
    }
  }

  if (enclosuresByType.size === 0) return null;

  // Get the amp config
  const ampConfig = allAmpConfigs.find(c => c.key === ampConfigKey);
  if (!ampConfig) return null;

  // Calculate the minimum outputs needed if we pack each type optimally
  let minOutputsNeeded = 0;
  const typeAllocations: Array<{ enclosure: Enclosure; count: number; outputsNeeded: number; perOutput: number }> = [];

  for (const { enclosure, totalCount } of enclosuresByType.values()) {
    const limits = enclosure.max_enclosures[ampConfigKey];
    if (!limits) return null; // Not compatible

    const outputsNeeded = Math.ceil(totalCount / limits.per_output);
    minOutputsNeeded += outputsNeeded;
    typeAllocations.push({ enclosure, count: totalCount, outputsNeeded, perOutput: limits.per_output });
  }

  // Check if consolidation can free up any outputs
  const currentUsedOutputs = countUsedOutputs(outputs);
  if (minOutputsNeeded >= currentUsedOutputs) {
    // Can't free any outputs
    return null;
  }

  console.log(`[consolidateOutputs] Can consolidate from ${currentUsedOutputs} to ${minOutputsNeeded} outputs`);

  // Create new consolidated outputs
  const newOutputs: OutputAllocation[] = [];
  for (let i = 0; i < ampConfig.outputs; i++) {
    newOutputs.push({
      outputIndex: i,
      enclosures: [],
      totalEnclosures: 0,
      impedanceOhms: Infinity,
    });
  }

  // Allocate each enclosure type, packing as tightly as possible
  let outputIdx = 0;
  for (const { enclosure, count, perOutput } of typeAllocations) {
    let remaining = count;

    while (remaining > 0 && outputIdx < ampConfig.outputs) {
      const toAllocate = Math.min(remaining, perOutput);

      // Find the original limits to get minImpedanceOverride
      const limits = enclosure.max_enclosures[ampConfigKey];

      newOutputs[outputIdx].enclosures.push({ enclosure, count: toAllocate });
      newOutputs[outputIdx].totalEnclosures = toAllocate;
      newOutputs[outputIdx].impedanceOhms = calculateParallelImpedance(
        enclosure.nominal_impedance_ohms,
        toAllocate
      );
      if (limits?.min_impedance_override !== undefined) {
        newOutputs[outputIdx].minImpedanceOverride = limits.min_impedance_override;
      }

      remaining -= toAllocate;
      outputIdx++;
    }
  }

  console.log(`[consolidateOutputs] Consolidated: ${countUsedOutputs(newOutputs)} used outputs, ${ampConfig.outputs - countUsedOutputs(newOutputs)} empty`);

  return newOutputs;
}

/**
 * Find a higher-output amp config that can accommodate all existing enclosures plus a new one.
 * Returns the upgrade candidate or null if no suitable upgrade exists.
 */
function findUpgradeCandidate(
  currentAmpInstance: AmpInstance,
  newEnclosure: Enclosure,
  newEnclosureCount: number,
  allAmpConfigs: AmpConfig[]
): { ampConfig: AmpConfig; candidate: SolverCandidate } | null {
  const existingEnclosures = getEnclosureTypesFromOutputs(currentAmpInstance.outputs);
  const usedOutputs = countUsedOutputs(currentAmpInstance.outputs);

  // We need at least 1 more output than currently used
  const minOutputsNeeded = usedOutputs + 1;

  // Get compatible amp configs for the new enclosure, sorted by powerRank
  const newEnclosureCandidates = getCompatibleConfigs(newEnclosure, allAmpConfigs);

  for (const candidate of newEnclosureCandidates) {
    const ampConfig = candidate.ampConfig;

    // Skip if same or fewer outputs than current amp
    if (ampConfig.outputs <= currentAmpInstance.ampConfig.outputs) continue;

    // Skip if not enough outputs
    if (ampConfig.outputs < minOutputsNeeded) continue;

    // Check if this amp config is compatible with ALL existing enclosure types
    let allCompatible = true;
    for (const existingEnc of existingEnclosures) {
      const limits = existingEnc.max_enclosures[ampConfig.key];
      if (!limits) {
        allCompatible = false;
        break;
      }
    }

    if (!allCompatible) continue;

    // Check load capacity - would total load be <= 100%?
    let totalLoad = 0;

    // Load from existing enclosures
    for (const output of currentAmpInstance.outputs) {
      for (const entry of output.enclosures) {
        const limits = entry.enclosure.max_enclosures[ampConfig.key];
        if (limits) {
          totalLoad += (entry.count / limits.per_amplifier) * 100;
        }
      }
    }

    // Load from new enclosures
    const newLimits = newEnclosure.max_enclosures[ampConfig.key];
    if (newLimits) {
      totalLoad += (newEnclosureCount / newLimits.per_amplifier) * 100;
    }

    if (totalLoad > 100) continue;

    console.log(`[findUpgradeCandidate] Found upgrade: ${currentAmpInstance.ampConfig.key} -> ${ampConfig.key} (${usedOutputs} used outputs -> ${ampConfig.outputs} total outputs, load would be ${Math.round(totalLoad)}%)`);
    return { ampConfig, candidate };
  }

  return null;
}

/**
 * Upgrade an amp instance to a new amp config with more outputs.
 * Preserves existing enclosures on their outputs and adds empty outputs for new enclosures.
 */
function upgradeAmpInstance(
  ampInstance: AmpInstance,
  newAmpConfig: AmpConfig,
  allAmpConfigs: AmpConfig[],
  ampInstances: AmpInstance[]
): void {
  const oldConfig = ampInstance.ampConfig;
  const oldOutputs = ampInstance.outputs;

  console.log(`[upgradeAmpInstance] Upgrading ${ampInstance.id} from ${oldConfig.key} to ${newAmpConfig.key}`);

  // Create new outputs array with the new amp's output count
  const newOutputs: OutputAllocation[] = [];

  // Copy existing used outputs
  for (let i = 0; i < oldOutputs.length; i++) {
    if (oldOutputs[i].totalEnclosures > 0) {
      newOutputs.push({ ...oldOutputs[i], outputIndex: newOutputs.length });
    }
  }

  // Add empty outputs up to new amp's output count
  while (newOutputs.length < newAmpConfig.outputs) {
    newOutputs.push({
      outputIndex: newOutputs.length,
      enclosures: [],
      totalEnclosures: 0,
      impedanceOhms: Infinity,
    });
  }

  // Update the amp instance
  ampInstance.ampConfig = newAmpConfig;
  ampInstance.outputs = newOutputs;

  // Generate new ID based on the new config
  const newIndex = ampInstances.filter(
    (i) => i !== ampInstance && i.ampConfig.key === newAmpConfig.key
  ).length;
  ampInstance.id = generateAmpId(newAmpConfig.key, newIndex);

  // Recalculate load percent
  ampInstance.loadPercent = calculateMixedLoadPercent(newOutputs, newAmpConfig.key, allAmpConfigs);

  console.log(`[upgradeAmpInstance] Upgraded to ${ampInstance.id}, ${countUsedOutputs(newOutputs)} used outputs, ${newOutputs.length - countUsedOutputs(newOutputs)} empty outputs, load=${ampInstance.loadPercent}%`);
}

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
  // Candidates are already sorted by powerRank (lowest first)
  const candidates = getCompatibleConfigs(enclosure, allAmpConfigs);

  if (candidates.length === 0) return null;

  console.log(`[findBestAmpConfig] ${enclosure.enclosure} x${quantity}, candidates:`,
    candidates.map(c => `${c.ampConfigKey}(rank=${c.ampConfig.powerRank}, perAmp=${c.enclosuresPerAmp})`));

  // Find the minimum amp count needed across all candidates
  let minAmpCount = Infinity;
  for (const candidate of candidates) {
    const ampCount = Math.ceil(quantity / candidate.enclosuresPerAmp);
    console.log(`[findBestAmpConfig] ${candidate.ampConfigKey}: ceil(${quantity}/${candidate.enclosuresPerAmp}) = ${ampCount} amps`);
    if (ampCount < minAmpCount) {
      minAmpCount = ampCount;
    }
  }

  console.log(`[findBestAmpConfig] minAmpCount = ${minAmpCount}`);

  // Among candidates that achieve the minimum amp count, pick the one with lowest powerRank
  // Since candidates are sorted by powerRank (lowest first), the first one with minAmpCount wins
  for (const candidate of candidates) {
    const ampCount = Math.ceil(quantity / candidate.enclosuresPerAmp);
    if (ampCount === minAmpCount) {
      console.log(`[findBestAmpConfig] Selected: ${candidate.ampConfigKey} (first with minAmpCount)`);
      return candidate;
    }
  }

  return candidates[0]; // Fallback (shouldn't reach here)
}

// =============================================================================
// Output Allocation Logic
// =============================================================================

/**
 * Check if a given impedance is rated for the amp.
 * E.g., 8Ω is rated on LA12X (which has [8, 4, 2.7]), but 16Ω is not.
 * An impedance is rated if it is at or below the highest rated impedance threshold.
 * 16Ω on LA12X: 16 > max(8,4,2.7) = 8 → NOT rated.
 * 8Ω on LA12X: 8 <= 8 → rated.
 * 16Ω on LA4X: 16 <= max(16,8,4) = 16 → rated.
 */
function isImpedanceRated(impedanceOhms: number, ratedImpedances: number[]): boolean {
  if (ratedImpedances.length === 0) return false;
  const maxRated = Math.max(...ratedImpedances);
  return impedanceOhms <= maxRated;
}

/**
 * Calculate the minimum number of enclosures needed per output to achieve acceptable impedance.
 * Uses the amp's rated impedances from byLoad data to determine valid ranges.
 *
 * Returns the minimum count needed, or the perOutput limit if even max doesn't work.
 */
function getMinimumPerOutputForImpedance(
  enclosure: Enclosure,
  limits: { perOutput: number; minImpedanceOverride?: number },
  ratedImpedances?: number[]
): number {
  const minAllowedImpedance = limits.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;

  // Find minimum count where impedance is above the hard floor.
  // Above-rated impedance (e.g., 16Ω on an 8Ω-max amp) is allowed — it just shows
  // a warning icon, not a forced minimum count bump.
  for (let count = 1; count <= limits.perOutput; count++) {
    const impedance = calculateParallelImpedance(enclosure.nominal_impedance_ohms, count);
    if (impedance >= minAllowedImpedance) return count;
  }

  // If no count gives acceptable impedance, use preferredPerOutput or 1
  return enclosure.preferredPerOutput;
}

/**
 * Get the minimum enclosure count needed for a given enclosure across all enabled amp configs.
 * Returns 1 if at least one amp can handle 1 enclosure at a rated impedance.
 * Used by UI to enforce minimum quantity and show "Minimum enclosure count" message.
 */
export function getMinimumEnclosureCount(
  enclosure: Enclosure,
  enabledAmpConfigs: AmpConfig[]
): number {
  let globalMin = Infinity;

  for (const config of enabledAmpConfigs) {
    const limits = enclosure.max_enclosures[config.key];
    if (!limits) continue; // This amp doesn't support this enclosure

    const minForThisAmp = getMinimumPerOutputForImpedance(
      enclosure,
      { perOutput: limits.per_output, minImpedanceOverride: limits.min_impedance_override },
      config.ratedImpedances
    );
    globalMin = Math.min(globalMin, minForThisAmp);
  }

  return globalMin === Infinity ? 1 : globalMin;
}

/**
 * Allocate enclosures to outputs on a single amp.
 *
 * Distribution strategy:
 * 1. If parallelAllowed AND spreading is valid (impedance-wise):
 *    - First, spread enclosures across outputs (preferredPerOutput each, typically 1)
 *    - Then, if more enclosures remain, pack additional into existing outputs up to perOutput
 * 2. If parallelAllowed but spreading isn't valid (impedance too high):
 *    - Stack enclosures until impedance is acceptable, then spread at that count
 * 3. If not parallelAllowed: spread 1 per output (existing behavior)
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
    // Calculate minimum per output for valid impedance
    const minPerOutputForImpedance = getMinimumPerOutputForImpedance(enclosure, limits, ampConfig.ratedImpedances);

    // Effective minimum per output - use the higher of impedance requirement and preferredPerOutput
    // But preferredPerOutput of 1 means "spread as much as possible when valid"
    // So if impedance requires 2, use 2. If impedance allows 1 and preferred is 1, use 1.
    const effectiveMinPerOutput = Math.max(minPerOutputForImpedance, enclosure.preferredPerOutput);

    // Max rated impedance threshold - outputs at or above this show "add 1 more enclosure" warning
    const maxRated = ampConfig.ratedImpedances.length > 0 ? Math.max(...ampConfig.ratedImpedances) : Infinity;

    // Phase 1: Spread enclosures across outputs, but pack each output past the above-rated
    // threshold before moving to the next. This ensures enclosures go to outputs that need
    // them (showing "add 1 more" warning) rather than spreading thinly across many outputs.
    let outputIdx = 0;
    while (remaining >= effectiveMinPerOutput && outputIdx < ampConfig.outputs) {
      const initialAllocation = Math.min(effectiveMinPerOutput, limits.perOutput);
      outputs[outputIdx].enclosures.push({
        enclosure,
        count: initialAllocation,
      });
      outputs[outputIdx].totalEnclosures = initialAllocation;
      outputs[outputIdx].impedanceOhms = calculateParallelImpedance(
        enclosure.nominal_impedance_ohms,
        initialAllocation
      );
      if (limits.minImpedanceOverride !== undefined) {
        outputs[outputIdx].minImpedanceOverride = limits.minImpedanceOverride;
      }
      remaining -= initialAllocation;

      // If this output is still at or above maxRated, keep adding enclosures to it
      // before moving to the next output (resolves "add 1 more enclosure" warning)
      while (
        remaining > 0 &&
        outputs[outputIdx].impedanceOhms > maxRated &&
        outputs[outputIdx].totalEnclosures < limits.perOutput
      ) {
        const newCount = outputs[outputIdx].totalEnclosures + 1;
        outputs[outputIdx].enclosures[0].count = newCount;
        outputs[outputIdx].totalEnclosures = newCount;
        outputs[outputIdx].impedanceOhms = calculateParallelImpedance(
          enclosure.nominal_impedance_ohms,
          newCount
        );
        remaining--;
      }

      outputIdx++;
    }

    // Phase 2: Pack additional enclosures into existing outputs
    // Prioritize outputs that are still at or above maxRated (showing warning) first
    while (remaining > 0) {
      let allocated = false;

      // First pass: add to above-rated outputs (those showing "add 1 more" warning)
      for (let i = 0; i < ampConfig.outputs && remaining > 0; i++) {
        if (
          outputs[i].totalEnclosures > 0 &&
          outputs[i].totalEnclosures < limits.perOutput &&
          outputs[i].impedanceOhms > maxRated
        ) {
          const newCount = outputs[i].totalEnclosures + 1;
          outputs[i].enclosures[0].count = newCount;
          outputs[i].totalEnclosures = newCount;
          outputs[i].impedanceOhms = calculateParallelImpedance(
            enclosure.nominal_impedance_ohms,
            newCount
          );
          remaining--;
          allocated = true;
        }
      }

      // Second pass: if no above-rated outputs remain, use round-robin on all outputs
      if (!allocated) {
        for (let i = 0; i < ampConfig.outputs && remaining > 0; i++) {
          if (outputs[i].totalEnclosures > 0 && outputs[i].totalEnclosures < limits.perOutput) {
            const newCount = outputs[i].totalEnclosures + 1;
            outputs[i].enclosures[0].count = newCount;
            outputs[i].totalEnclosures = newCount;
            outputs[i].impedanceOhms = calculateParallelImpedance(
              enclosure.nominal_impedance_ohms,
              newCount
            );
            remaining--;
            allocated = true;
          }
        }
      }

      if (!allocated) break;
    }

    // Phase 3: If there are still remaining enclosures and empty outputs,
    // allocate to them (for cases where effectiveMinPerOutput > remaining initially)
    outputIdx = 0;
    while (remaining > 0) {
      // Find next empty output
      while (outputIdx < ampConfig.outputs && outputs[outputIdx].totalEnclosures > 0) {
        outputIdx++;
      }
      if (outputIdx >= ampConfig.outputs) break;

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
 * IMPORTANT: Respects load percentage limit - won't add if amp is at capacity.
 * NOTE: Enclosure type limit (max 3 types) is checked by the caller before calling this function.
 */
function mergeIntoOutputs(
  existingOutputs: OutputAllocation[],
  enclosure: Enclosure,
  count: number,
  limits: { perOutput: number; perAmplifier: number; minImpedanceOverride?: number },
  currentLoadPercent: number
): { outputs: OutputAllocation[]; allocated: number } {
  let remaining = count;
  const outputs = existingOutputs.map((o) => ({ ...o, enclosures: [...o.enclosures] }));

  // Calculate how much load each enclosure of this type adds
  const loadPerEnclosure = 100 / limits.perAmplifier;

  // Track current load as we allocate
  let currentLoad = currentLoadPercent;

  // Don't allocate if amp is already at or over capacity
  if (currentLoad >= 100) {
    return { outputs, allocated: 0 };
  }

  if (enclosure.parallelAllowed) {
    // Only add to EMPTY outputs - never mix enclosure types on the same output
    for (let i = 0; i < outputs.length && remaining > 0; i++) {
      // Skip outputs that already have enclosures
      if (outputs[i].totalEnclosures > 0) continue;

      // Check if adding more would exceed 100% load
      if (currentLoad >= 100) break;

      // Calculate how many we can add without exceeding 100%
      const loadRemaining = 100 - currentLoad;
      const maxByLoad = Math.floor(loadRemaining / loadPerEnclosure);
      const toAllocate = Math.min(remaining, limits.perOutput, Math.max(1, maxByLoad));

      if (toAllocate <= 0) break;

      // Check if this would push us over 100%
      const newLoad = currentLoad + (toAllocate * loadPerEnclosure);
      if (newLoad > 100 && currentLoad > 0) {
        // Try allocating fewer
        const safeCount = Math.floor((100 - currentLoad) / loadPerEnclosure);
        if (safeCount <= 0) break;
        // Use safeCount instead
        outputs[i].enclosures.push({ enclosure, count: safeCount });
        outputs[i].totalEnclosures = safeCount;
        outputs[i].impedanceOhms = calculateParallelImpedance(
          enclosure.nominal_impedance_ohms,
          safeCount
        );
        if (limits.minImpedanceOverride !== undefined) {
          outputs[i].minImpedanceOverride = limits.minImpedanceOverride;
        }
        remaining -= safeCount;
        currentLoad += safeCount * loadPerEnclosure;
      } else {
        outputs[i].enclosures.push({ enclosure, count: toAllocate });
        outputs[i].totalEnclosures = toAllocate;
        outputs[i].impedanceOhms = calculateParallelImpedance(
          enclosure.nominal_impedance_ohms,
          toAllocate
        );
        if (limits.minImpedanceOverride !== undefined) {
          outputs[i].minImpedanceOverride = limits.minImpedanceOverride;
        }
        remaining -= toAllocate;
        currentLoad += toAllocate * loadPerEnclosure;
      }
    }
  } else {
    // No parallel - only add to empty outputs, 1 per output
    for (let i = 0; i < outputs.length && remaining > 0; i++) {
      // Check if adding one more would exceed 100% load
      if (currentLoad + loadPerEnclosure > 100) break;

      if (outputs[i].totalEnclosures === 0) {
        outputs[i].enclosures.push({ enclosure, count: 1 });
        outputs[i].totalEnclosures = 1;
        outputs[i].impedanceOhms = enclosure.nominal_impedance_ohms;
        if (limits.minImpedanceOverride !== undefined) {
          outputs[i].minImpedanceOverride = limits.minImpedanceOverride;
        }
        remaining--;
        currentLoad += loadPerEnclosure;
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

  // Initial check for compatibility
  const initialCandidate = findBestAmpConfig(enclosure, quantity, allAmpConfigs);

  if (!initialCandidate) {
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
  const configsUsed = new Set<string>();
  let remaining = quantity;
  let maxPowerRank = 0;

  // Re-evaluate best amp for each iteration based on remaining quantity
  // This ensures we pick the most efficient amp for overflow (e.g., LA4X for 1 K2 instead of LA12X)
  while (remaining > 0) {
    // Find the best amp for the remaining quantity
    const bestCandidate = findBestAmpConfig(enclosure, remaining, allAmpConfigs);
    if (!bestCandidate) break; // Shouldn't happen if initialCandidate was found

    const toAllocate = Math.min(remaining, bestCandidate.enclosuresPerAmp);
    const outputs = allocateToOutputs(
      enclosure,
      toAllocate,
      bestCandidate.ampConfig,
      { perOutput: bestCandidate.perOutput, perAmplifier: bestCandidate.perAmplifier, minImpedanceOverride: bestCandidate.minImpedanceOverride }
    );

    // Count how many of this amp type we've already created
    const ampIndex = ampInstances.filter((i) => i.ampConfig.key === bestCandidate.ampConfigKey).length;

    const ampInstance: AmpInstance = {
      id: generateAmpId(bestCandidate.ampConfigKey, ampIndex),
      ampConfig: bestCandidate.ampConfig,
      outputs,
      totalEnclosures: toAllocate,
      loadPercent: Math.round((toAllocate / bestCandidate.perAmplifier) * 100),
    };

    ampInstances.push(ampInstance);
    configsUsed.add(bestCandidate.ampConfigKey);
    maxPowerRank = Math.max(maxPowerRank, bestCandidate.ampConfig.powerRank);
    remaining -= toAllocate;
  }

  // Collect all amp configs used
  const ampConfigsUsed = allAmpConfigs.filter((c) => configsUsed.has(c.key));

  return {
    success: true,
    ampInstances,
    summary: {
      totalAmplifiers: ampInstances.length,
      totalEnclosuresAllocated: quantity,
      ampConfigsUsed,
      maxPowerRank,
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

/**
 * Calculate the total load percentage for a set of requests on a given amp config.
 * This determines how many amps are needed based on combined per_amplifier limits.
 */
function calculateTotalLoadPercent(
  requests: EnclosureRequest[],
  ampConfigKey: string,
  allAmpConfigs: AmpConfig[]
): number {
  let totalLoadPercent = 0;

  for (const request of requests) {
    const candidates = getCompatibleConfigs(request.enclosure, allAmpConfigs);
    const candidate = candidates.find((c) => c.ampConfigKey === ampConfigKey);
    if (!candidate) return Infinity; // Not compatible

    totalLoadPercent += (request.quantity / candidate.perAmplifier) * 100;
  }

  return totalLoadPercent;
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
    const totalLoadPercent = calculateTotalLoadPercent(requests, ampConfig.key, allAmpConfigs);

    // Amps needed is the MAX of:
    // 1. Outputs needed / outputs per amp (physical output constraint)
    // 2. Total load / 100 (per_amplifier capacity constraint)
    const ampsByOutputs = Math.ceil(outputsNeeded / ampConfig.outputs);
    const ampsByLoad = Math.ceil(totalLoadPercent / 100);
    const ampsNeeded = Math.max(ampsByOutputs, ampsByLoad);

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
  let independentMaxPowerRank = 0;
  let independentSumPowerRank = 0;
  for (const request of requests) {
    const best = findBestAmpConfig(request.enclosure, request.quantity, allAmpConfigs);
    if (best) {
      const ampsForThis = Math.ceil(request.quantity / best.enclosuresPerAmp);
      independentAmpsNeeded += ampsForThis;
      independentMaxPowerRank = Math.max(independentMaxPowerRank, best.ampConfig.powerRank);
      independentSumPowerRank += best.ampConfig.powerRank * ampsForThis;
    }
  }

  // Compare shared vs independent solutions
  // Prefer shared only if it uses FEWER amps, or same amps with lower power
  if (bestSharedSolution) {
    const sharedSumPowerRank = bestSharedSolution.ampConfig.powerRank * bestSharedSolution.ampsNeeded;

    // Shared is better if:
    // 1. Fewer amps, OR
    // 2. Same amps AND lower max power rank, OR
    // 3. Same amps AND same max power rank AND lower total power rank
    const sharedIsBetter =
      bestSharedSolution.ampsNeeded < independentAmpsNeeded ||
      (bestSharedSolution.ampsNeeded === independentAmpsNeeded &&
        bestSharedSolution.ampConfig.powerRank < independentMaxPowerRank) ||
      (bestSharedSolution.ampsNeeded === independentAmpsNeeded &&
        bestSharedSolution.ampConfig.powerRank === independentMaxPowerRank &&
        sharedSumPowerRank < independentSumPowerRank);

    if (sharedIsBetter) {
      return buildSharedSolution(requests, bestSharedSolution.ampConfig, allAmpConfigs);
    }
  }

  // Fall back to independent solving
  return solveIndependently(requests, allAmpConfigs);
}

/**
 * Calculate load percentage for an amp instance with mixed enclosure types.
 * Load is the sum of each enclosure type's contribution: (count / perAmplifier) for each type.
 */
function calculateMixedLoadPercent(
  outputs: OutputAllocation[],
  ampConfigKey: string,
  allAmpConfigs: AmpConfig[]
): number {
  // Count enclosures by type
  const enclosureCounts = new Map<string, { count: number; enclosure: Enclosure }>();

  for (const output of outputs) {
    for (const entry of output.enclosures) {
      const key = entry.enclosure.enclosure;
      const existing = enclosureCounts.get(key);
      if (existing) {
        existing.count += entry.count;
      } else {
        enclosureCounts.set(key, { count: entry.count, enclosure: entry.enclosure });
      }
    }
  }

  // Sum up load contributions from each enclosure type
  let totalLoadPercent = 0;
  for (const { count, enclosure } of enclosureCounts.values()) {
    const limits = enclosure.max_enclosures[ampConfigKey];
    if (limits) {
      totalLoadPercent += (count / limits.per_amplifier) * 100;
    }
  }

  return Math.round(totalLoadPercent);
}

/** Build a solution using a shared amp config for all enclosure types */
function buildSharedSolution(
  requests: EnclosureRequest[],
  ampConfig: AmpConfig,
  allAmpConfigs: AmpConfig[]
): SolverSolution {
  const ampInstances: AmpInstance[] = [];
  let totalAllocated = 0;
  const configsUsed = new Set<string>([ampConfig.key]);

  console.log(`[buildSharedSolution] Starting with shared amp: ${ampConfig.key}`);

  // Process each request, filling amps and creating new ones as needed
  for (const request of requests) {
    const { enclosure, quantity } = request;
    let remaining = quantity;

    console.log(`[buildSharedSolution] Processing ${enclosure.enclosure} x${quantity}`);

    // Get the limits for this enclosure on the chosen amp
    const candidates = getCompatibleConfigs(enclosure, allAmpConfigs);
    const candidate = candidates.find((c) => c.ampConfigKey === ampConfig.key);

    console.log(`[buildSharedSolution] Candidate for shared amp:`, candidate ? `${candidate.ampConfigKey} (perAmp=${candidate.perAmplifier})` : 'NONE');

    if (!candidate) continue;

    // Try to fill existing amps first (only empty outputs)
    for (const ampInstance of ampInstances) {
      if (remaining <= 0) break;

      console.log(`[buildSharedSolution] Checking existing amp ${ampInstance.id} (type=${ampInstance.ampConfig.key})`);

      // Only try to fill amps of the shared type (not overflow amps)
      if (ampInstance.ampConfig.key !== ampConfig.key) {
        console.log(`[buildSharedSolution] Skipping - not shared type`);
        continue;
      }

      // Check enclosure type limit - skip if adding this type would exceed max
      const currentTypeCount = countEnclosureTypesOnAmp(ampInstance.outputs);
      const typeAlreadyOnAmp = isEnclosureTypeOnAmp(ampInstance.outputs, enclosure.enclosure);
      if (!typeAlreadyOnAmp && currentTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP) {
        console.log(`[buildSharedSolution] Skipping - already has ${currentTypeCount} enclosure types (max ${MAX_ENCLOSURE_TYPES_PER_AMP})`);
        continue;
      }

      // Calculate current load to check if amp has capacity
      const currentLoad = calculateMixedLoadPercent(ampInstance.outputs, ampConfig.key, allAmpConfigs);
      console.log(`[buildSharedSolution] Current load: ${currentLoad}%`);
      if (currentLoad >= 100) {
        console.log(`[buildSharedSolution] Skipping - amp is full`);
        continue; // Amp is full
      }

      // Count empty outputs
      const emptyOutputs = ampInstance.outputs.filter(o => o.totalEnclosures === 0).length;
      console.log(`[buildSharedSolution] Empty outputs: ${emptyOutputs}`);

      let { outputs, allocated } = mergeIntoOutputs(
        ampInstance.outputs,
        enclosure,
        remaining,
        { perOutput: candidate.perOutput, perAmplifier: candidate.perAmplifier, minImpedanceOverride: candidate.minImpedanceOverride },
        currentLoad  // Pass current load percentage, not enclosure count
      );

      console.log(`[buildSharedSolution] Merge result: allocated=${allocated}`);

      // If merge failed (no empty outputs) but amp has capacity, try consolidating
      if (allocated === 0 && currentLoad < 100 && emptyOutputs === 0) {
        console.log(`[buildSharedSolution] Attempting to consolidate outputs on ${ampInstance.id}`);
        const consolidated = consolidateOutputs(ampInstance.outputs, ampInstance.ampConfig.key, allAmpConfigs);
        if (consolidated) {
          // Consolidation successful - update amp and retry merge
          ampInstance.outputs = consolidated;
          const newEmptyOutputs = consolidated.filter(o => o.totalEnclosures === 0).length;
          console.log(`[buildSharedSolution] Consolidation freed ${newEmptyOutputs} outputs, retrying merge`);

          const retryResult = mergeIntoOutputs(
            ampInstance.outputs,
            enclosure,
            remaining,
            { perOutput: candidate.perOutput, perAmplifier: candidate.perAmplifier, minImpedanceOverride: candidate.minImpedanceOverride },
            currentLoad
          );
          outputs = retryResult.outputs;
          allocated = retryResult.allocated;
          console.log(`[buildSharedSolution] Retry merge result: allocated=${allocated}`);
        }
      }

      if (allocated > 0) {
        ampInstance.outputs = outputs;
        ampInstance.totalEnclosures += allocated;
        // Recalculate load percent based on all enclosure types on this amp
        ampInstance.loadPercent = calculateMixedLoadPercent(ampInstance.outputs, ampConfig.key, allAmpConfigs);
        remaining -= allocated;
        console.log(`[buildSharedSolution] After merge: remaining=${remaining}, newLoad=${ampInstance.loadPercent}%`);
      }
    }

    // Create new amps for remaining
    // Check if we can fit on existing amps of OTHER types first, then pick the most efficient new amp
    while (remaining > 0) {
      // First, try to fit on existing amps of any compatible type (not just shared type)
      let fittedOnExisting = false;
      for (const ampInstance of ampInstances) {
        if (remaining <= 0) break;

        // Check if this amp type is compatible with this enclosure
        const compatCandidate = candidates.find((c) => c.ampConfigKey === ampInstance.ampConfig.key);
        if (!compatCandidate) continue;

        // Check enclosure type limit
        const currentTypeCount = countEnclosureTypesOnAmp(ampInstance.outputs);
        const typeAlreadyOnAmp = isEnclosureTypeOnAmp(ampInstance.outputs, enclosure.enclosure);
        if (!typeAlreadyOnAmp && currentTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP) {
          continue;
        }

        // Check if amp has capacity
        const currentLoad = calculateMixedLoadPercent(ampInstance.outputs, ampInstance.ampConfig.key, allAmpConfigs);
        if (currentLoad >= 100) continue;

        // Check for empty outputs
        const emptyOutputs = ampInstance.outputs.filter(o => o.totalEnclosures === 0).length;
        if (emptyOutputs === 0) continue;

        const { outputs, allocated } = mergeIntoOutputs(
          ampInstance.outputs,
          enclosure,
          remaining,
          { perOutput: compatCandidate.perOutput, perAmplifier: compatCandidate.perAmplifier, minImpedanceOverride: compatCandidate.minImpedanceOverride },
          currentLoad
        );

        if (allocated > 0) {
          console.log(`[buildSharedSolution] Fitted ${allocated}x ${enclosure.enclosure} on existing ${ampInstance.id}`);
          ampInstance.outputs = outputs;
          ampInstance.totalEnclosures += allocated;
          ampInstance.loadPercent = calculateMixedLoadPercent(ampInstance.outputs, ampInstance.ampConfig.key, allAmpConfigs);
          remaining -= allocated;
          fittedOnExisting = true;
        }
      }

      if (fittedOnExisting || remaining <= 0) continue;

      // Try to upgrade an existing amp to a higher-output model instead of creating a new amp
      let upgradedExisting = false;
      for (const ampInstance of ampInstances) {
        if (remaining <= 0) break;

        // Check enclosure type limit
        const currentTypeCount = countEnclosureTypesOnAmp(ampInstance.outputs);
        const typeAlreadyOnAmp = isEnclosureTypeOnAmp(ampInstance.outputs, enclosure.enclosure);
        if (!typeAlreadyOnAmp && currentTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP) {
          continue;
        }

        // Check if this amp has no empty outputs (otherwise we would have fitted above)
        const emptyOutputs = ampInstance.outputs.filter(o => o.totalEnclosures === 0).length;
        if (emptyOutputs > 0) continue; // Already tried fitting above

        // Try to find an upgrade for this amp
        const upgrade = findUpgradeCandidate(ampInstance, enclosure, remaining, allAmpConfigs);
        if (!upgrade) continue;

        console.log(`[buildSharedSolution] Upgrading ${ampInstance.id} to ${upgrade.ampConfig.key} to fit ${enclosure.enclosure}`);

        // Perform the upgrade
        upgradeAmpInstance(ampInstance, upgrade.ampConfig, allAmpConfigs, ampInstances);
        configsUsed.add(upgrade.ampConfig.key);

        // Now merge the new enclosure onto the upgraded amp
        const currentLoad = calculateMixedLoadPercent(ampInstance.outputs, ampInstance.ampConfig.key, allAmpConfigs);
        const { outputs, allocated } = mergeIntoOutputs(
          ampInstance.outputs,
          enclosure,
          remaining,
          { perOutput: upgrade.candidate.perOutput, perAmplifier: upgrade.candidate.perAmplifier, minImpedanceOverride: upgrade.candidate.minImpedanceOverride },
          currentLoad
        );

        if (allocated > 0) {
          console.log(`[buildSharedSolution] After upgrade, fitted ${allocated}x ${enclosure.enclosure} on ${ampInstance.id}`);
          ampInstance.outputs = outputs;
          ampInstance.totalEnclosures += allocated;
          ampInstance.loadPercent = calculateMixedLoadPercent(ampInstance.outputs, ampInstance.ampConfig.key, allAmpConfigs);
          remaining -= allocated;
          upgradedExisting = true;
          break; // Only upgrade one amp per iteration
        }
      }

      if (upgradedExisting || remaining <= 0) continue;

      // No existing amp can take this enclosure - create a new amp
      // Strategy:
      // 1. If NO shared-type amps exist yet, ALWAYS create one (to enable sharing)
      // 2. Otherwise, use the most efficient amp for this specific remaining quantity
      let chosenCandidate: SolverCandidate | null = null;

      // Check if there are any existing amps of the shared type
      const sharedTypeAmpsExist = ampInstances.some(amp => amp.ampConfig.key === ampConfig.key);

      if (candidate && !sharedTypeAmpsExist) {
        // No shared-type amps exist yet - create one to enable sharing with future enclosures
        chosenCandidate = candidate;
        console.log(`[buildSharedSolution] Creating new ${chosenCandidate.ampConfigKey} for ${enclosure.enclosure} (first shared amp - enables consolidation)`);
      } else {
        // Shared amps exist (or shared amp not compatible) - use most efficient for this quantity
        const bestCandidate = findBestAmpConfig(enclosure, remaining, allAmpConfigs);
        if (!bestCandidate) {
          console.log(`[buildSharedSolution] ERROR: No compatible amp for ${enclosure.enclosure}`);
          break;
        }
        chosenCandidate = bestCandidate;
        console.log(`[buildSharedSolution] Creating new ${chosenCandidate.ampConfigKey} for ${enclosure.enclosure} (most efficient for ${remaining})`);
      }


      const chosenConfig = chosenCandidate.ampConfig;

      configsUsed.add(chosenConfig.key);

      const toAllocate = Math.min(remaining, chosenCandidate.perAmplifier);
      const outputs = allocateToOutputs(enclosure, toAllocate, chosenConfig, {
        perOutput: chosenCandidate.perOutput,
        perAmplifier: chosenCandidate.perAmplifier,
        minImpedanceOverride: chosenCandidate.minImpedanceOverride,
      });

      const ampIndex = ampInstances.filter((i) => i.ampConfig.key === chosenConfig.key).length;

      ampInstances.push({
        id: generateAmpId(chosenConfig.key, ampIndex),
        ampConfig: chosenConfig,
        outputs,
        totalEnclosures: toAllocate,
        // Load percent based on this enclosure type's contribution
        loadPercent: calculateMixedLoadPercent(outputs, chosenConfig.key, allAmpConfigs),
      });

      remaining -= toAllocate;
    }

    totalAllocated += quantity;
  }

  // Collect all amp configs actually used (from ampInstances, not configsUsed tracking set)
  // The configsUsed set may contain stale entries from upgraded amps
  const actualConfigKeys = new Set(ampInstances.map(i => i.ampConfig.key));
  const ampConfigsUsed = allAmpConfigs.filter((c) => actualConfigKeys.has(c.key));
  const maxPowerRank = ampConfigsUsed.length > 0 ? Math.max(...ampConfigsUsed.map((c) => c.powerRank)) : 0;

  console.log('[buildSharedSolution] ampInstances:', ampInstances.map(i => `${i.id} (${i.ampConfig.key})`));
  console.log('[buildSharedSolution] actualConfigKeys:', [...actualConfigKeys]);
  console.log('[buildSharedSolution] ampConfigsUsed:', ampConfigsUsed.map(c => c.key));

  return {
    success: true,
    ampInstances,
    summary: {
      totalAmplifiers: ampInstances.length,
      totalEnclosuresAllocated: totalAllocated,
      ampConfigsUsed,
      maxPowerRank,
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

  // Derive ampConfigsUsed from actual instances for consistency
  const actualConfigKeys = new Set(allInstances.map(i => i.ampConfig.key));
  const ampConfigsUsed = allAmpConfigs.filter((c) => actualConfigKeys.has(c.key));

  console.log('[solveIndependently] allInstances:', allInstances.map(i => `${i.id} (${i.ampConfig.key})`));
  console.log('[solveIndependently] actualConfigKeys:', [...actualConfigKeys]);
  console.log('[solveIndependently] ampConfigsUsed:', ampConfigsUsed.map(c => c.key));

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
