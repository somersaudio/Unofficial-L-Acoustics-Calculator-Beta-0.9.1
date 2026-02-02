import React from "react"; // eslint-disable-line
import type { AmpInstance, OutputAllocation, ChannelTypes, ZoneWithSolution, SolverSolution } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS, getMaxCableLength } from "../types";
import { getImpedanceErrors } from "../solver/ampSolver";
import { generatePDFReport } from "../utils/pdfExport";

interface SolverResultsProps {
  zoneSolutions: ZoneWithSolution[];
  activeZoneId: string;
  salesMode?: boolean;
  cableGaugeMm2?: number;
  useFeet?: boolean;
}

function getImpedanceColor(impedance: number, minImpedanceOverride?: number): string {
  if (impedance === Infinity) return "text-gray-400 dark:text-neutral-600";
  const minAllowed = minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
  if (impedance < minAllowed) return "text-red-600 dark:text-red-500 font-bold";
  if (impedance < MIN_IMPEDANCE_OHMS) return "text-amber-500 dark:text-amber-500";
  return "text-green-600 dark:text-green-500";
}

function getLoadColor(loadPercent: number): string {
  if (loadPercent > 100) return "text-red-600 dark:text-red-500";
  if (loadPercent > 80) return "text-amber-600 dark:text-amber-500";
  return "text-green-600 dark:text-green-500";
}

const MAX_ENCLOSURE_TYPES_PER_AMP = 3;

// Get channel type for LA7.16(i) 16-channel amps
// Pattern: Ch 1,5,9,13 = LC | Ch 2,6,10,14 = LF | Ch 3,4,7,8,11,12,15,16 = HF
function getChannelType(outputIndex: number): string {
  const position = outputIndex % 4;
  if (position === 0) return "LC";
  if (position === 1) return "LF";
  return "HF";
}

function countEnclosureTypes(instance: AmpInstance): number {
  const types = new Set<string>();
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      types.add(entry.enclosure.enclosure);
    }
  }
  return types.size;
}

/** Compact cable length display for a given impedance and selected gauge */
function CableLengthInfo({ impedanceOhms, gaugeMm2, useFeet }: { impedanceOhms: number; gaugeMm2: number; useFeet: boolean }) {
  if (impedanceOhms === Infinity || impedanceOhms <= 0) return null;

  const limit = getMaxCableLength(impedanceOhms, gaugeMm2);
  if (!limit) return null;

  const hasLimit = limit.meters !== null;

  return (
    <div className="mt-1 text-[10px] text-gray-500 dark:text-neutral-500">
      {hasLimit ? (
        <span>Max cable: <span className="font-medium text-gray-700 dark:text-neutral-300">{useFeet ? `${limit.feet}ft` : `${limit.meters}m`}</span></span>
      ) : (
        <span className="text-amber-500">Not rated for {gaugeMm2}mm² cable</span>
      )}
    </div>
  );
}

function OutputCard({ output, ampOutputCount, salesMode = false, channelTypes, cableGaugeMm2, useFeet, ratedImpedances = [] }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; channelTypes?: ChannelTypes; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[] }) {
  const hasLoad = output.totalEnclosures > 0;
  const channelType = ampOutputCount === 16 ? getChannelType(output.outputIndex) : null;
  const outputLabel = ampOutputCount === 16
    ? `Ch ${output.outputIndex + 1} ${channelType}`
    : `Output ${output.outputIndex + 1}`;
  const minAllowed = output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
  const hasImpedanceError = !salesMode && output.impedanceOhms < minAllowed && output.impedanceOhms !== Infinity;

  // Get nominal impedance for this channel type (for 16-channel amps)
  const nominalImpedance = channelType && channelTypes?.nominalImpedance
    ? channelTypes.nominalImpedance[channelType]
    : null;

  const is16Channel = ampOutputCount === 16;

  return (
    <div
      className={`rounded border ${is16Channel ? "p-1 text-[10px]" : "p-2 text-xs"} ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
    >
      <div className={`${is16Channel ? "" : "mb-1"} font-medium text-gray-700 dark:text-neutral-400`}>
        {outputLabel}
        {!is16Channel && (
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
        )}
      </div>
      {hasLoad ? (
        is16Channel ? (
          /* 16-channel layout: enclosures first, then impedance (compact) */
          <>
            <div>
              {(() => {
                const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                const impedanceAboveRated = output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                return output.enclosures.map((entry, i) => {
                  const isL2Type = entry.enclosure.enclosure === "L2 / L2D";
                  const hideEnclosureName = isL2Type;
                  return hideEnclosureName ? null : (
                    <div key={i} className="flex items-center gap-1 text-gray-900 dark:text-gray-200">
                      {entry.count}x {entry.enclosure.enclosure}
                      {impedanceAboveRated && (
                        <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                        </svg>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
            {!salesMode && (
              <div
                className={`mt-0.5 pt-0.5 border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"} ${getImpedanceColor(
                  output.impedanceOhms,
                  output.minImpedanceOverride
                )}`}
              >
                {output.impedanceOhms === Infinity ? "No load" : `${output.impedanceOhms}Ω`}
                {hasImpedanceError && (
                  <span className="ml-1 text-red-600 dark:text-red-500">ERROR</span>
                )}
              </div>
            )}
          </>
        ) : (
          /* Standard output layout: Ch label, impedance, enclosures, cable length (matching PhysicalOutputCard) */
          <>
            {!salesMode && (
              <div className={`border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
                <div className={`pt-1 ${getImpedanceColor(output.impedanceOhms, output.minImpedanceOverride)}`}>
                  Ch {output.outputIndex + 1}: {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  {hasImpedanceError && (
                    <span className="ml-1 text-red-600 dark:text-red-500">ERROR</span>
                  )}
                </div>
                {(() => {
                  const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                  const impedanceAboveRated = output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                  return output.enclosures.map((entry, i) => (
                    <div key={i} className="flex items-center gap-1 text-gray-900 dark:text-gray-200">
                      {entry.count}x {entry.enclosure.enclosure}
                      {impedanceAboveRated && (
                        <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                        </svg>
                      )}
                    </div>
                  ));
                })()}
                <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
              </div>
            )}
            {salesMode && (
              <div className="space-y-1">
                {output.enclosures.map((entry, i) => (
                  <div key={i} className="text-gray-900 dark:text-gray-200">
                    {entry.count}x {entry.enclosure.enclosure}
                  </div>
                ))}
              </div>
            )}
          </>
        )
      ) : (
        // For 16-channel amps, show nominal impedance with same styling as loaded outputs; for 4-output amps, show "Empty"
        is16Channel && nominalImpedance && !salesMode ? (
          <div className="mt-0.5 pt-0.5 border-t border-gray-200 dark:border-neutral-700 text-green-600 dark:text-green-500">
            {nominalImpedance}Ω
          </div>
        ) : !is16Channel ? (
          <div className="text-gray-400 dark:text-neutral-600 italic">Empty</div>
        ) : null
      )}
    </div>
  );
}

/** Card for a physical output that groups multiple amp channels (e.g., LA12X NL4 carrying 2 channels) */
function PhysicalOutputCard({ outputs, physicalIndex, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [] }: { outputs: OutputAllocation[]; physicalIndex: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[] }) {
  // Aggregate enclosures across channels in this physical output
  const enclosureTotals = new Map<string, { enclosure: OutputAllocation["enclosures"][0]["enclosure"]; count: number }>();
  let totalEnclosures = 0;

  for (const output of outputs) {
    for (const entry of output.enclosures) {
      const key = entry.enclosure.enclosure;
      const existing = enclosureTotals.get(key);
      if (existing) {
        existing.count += entry.count;
      } else {
        enclosureTotals.set(key, { enclosure: entry.enclosure, count: entry.count });
      }
      totalEnclosures += entry.count;
    }
  }

  const hasLoad = totalEnclosures > 0;

  // Check impedance errors across all channels in this physical output
  const hasImpedanceError = !salesMode && outputs.some(
    (o) => o.impedanceOhms < (o.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && o.impedanceOhms !== Infinity
  );

  return (
    <div
      className={`rounded border p-2 text-xs ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
    >
      <div className="mb-1 font-medium text-gray-700 dark:text-neutral-400">
        Output {physicalIndex + 1}
        <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
      </div>
      {hasLoad ? (
        <>
          {!salesMode ? (
            <div className={`border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
              {outputs.map((output) => {
                const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                return (
                  <div key={output.outputIndex} className={output.outputIndex > outputs[0].outputIndex ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}>
                    <div className={getImpedanceColor(output.impedanceOhms, output.minImpedanceOverride)}>
                      Ch {output.outputIndex + 1}: {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                      {output.impedanceOhms !== Infinity && output.impedanceOhms < (output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && (
                        <span className="ml-1 text-red-600 dark:text-red-500">ERROR</span>
                      )}
                    </div>
                    {(() => {
                      const impedanceAboveRated = output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                      return output.enclosures.map((entry, i) => (
                        <div key={i} className="flex items-center gap-1 text-gray-900 dark:text-gray-200">
                          {entry.count}x {entry.enclosure.enclosure}
                          {impedanceAboveRated && (
                            <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                            </svg>
                          )}
                        </div>
                      ));
                    })()}
                    {output.impedanceOhms !== Infinity && output.impedanceOhms > 0 && (
                      <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-1">
              {Array.from(enclosureTotals.values()).map((entry, i) => (
                <div key={i} className="text-gray-900 dark:text-gray-200">
                  {entry.count}x {entry.enclosure.enclosure}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-400 dark:text-neutral-600 italic">Empty</div>
      )}
    </div>
  );
}

/** Group solver channel outputs into physical output groups */
function groupByPhysicalOutputs(outputs: OutputAllocation[], channelCount: number, physicalCount: number): OutputAllocation[][] {
  const channelsPerPhysical = Math.floor(channelCount / physicalCount);
  const groups: OutputAllocation[][] = [];
  for (let i = 0; i < physicalCount; i++) {
    const start = i * channelsPerPhysical;
    const end = start + channelsPerPhysical;
    groups.push(outputs.slice(start, end));
  }
  return groups;
}

// Grouped amp card for sales mode - shows multiple amps of same type as one entry
function GroupedAmpCard({ instances }: { instances: AmpInstance[] }) {
  const firstInstance = instances[0];
  const count = instances.length;

  // Aggregate enclosures across all instances
  const enclosureTotals = new Map<string, number>();
  for (const instance of instances) {
    for (const output of instance.outputs) {
      for (const entry of output.enclosures) {
        const name = entry.enclosure.enclosure;
        enclosureTotals.set(name, (enclosureTotals.get(name) || 0) + entry.count);
      }
    }
  }

  return (
    <div className="rounded-lg border border-gray-300 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="border-b border-gray-200 bg-gray-100 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-bold text-gray-900 dark:text-gray-200">
              {firstInstance.ampConfig.model}
            </span>
            {firstInstance.ampConfig.mode && (
              <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300">
                {firstInstance.ampConfig.mode}
              </span>
            )}
            <span className="ml-2 text-sm font-medium text-gray-700 dark:text-neutral-400">
              ({count})
            </span>
          </div>
        </div>
      </div>
      {enclosureTotals.size > 0 && (
        <div className="px-4 py-3">
          <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
            {Array.from(enclosureTotals.entries()).map(([name, total]) => (
              <div key={name}>{total}x {name}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AmpCard({ instance, salesMode = false, cableGaugeMm2, useFeet }: { instance: AmpInstance; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean }) {
  const ampOutputCount = instance.ampConfig.outputs;
  const physicalOutputCount = instance.ampConfig.physicalOutputs;
  const usePhysicalGrouping = physicalOutputCount < ampOutputCount;
  const hasAnyImpedanceError = !salesMode && instance.outputs.some(
    (o) => o.impedanceOhms < (o.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && o.impedanceOhms !== Infinity
  );
  const enclosureTypeCount = countEnclosureTypes(instance);
  const isAtMaxTypes = enclosureTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP;

  // Group channels into physical outputs when needed (e.g., LA12X: 4 channels -> 2 NL4 connectors)
  const physicalGroups = usePhysicalGrouping
    ? groupByPhysicalOutputs(instance.outputs, ampOutputCount, physicalOutputCount)
    : null;

  // Check if any output has impedance at or above max rated (for annotation legend)
  const maxRated = instance.ampConfig.ratedImpedances.length > 0 ? Math.max(...instance.ampConfig.ratedImpedances) : Infinity;
  const hasAboveRatedOutput = instance.outputs.some(
    (o) => o.totalEnclosures > 0 && o.impedanceOhms !== Infinity && o.impedanceOhms > maxRated
  );

  return (
    <div className={`rounded-lg border shadow-sm ${
      hasAnyImpedanceError ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30" : "border-gray-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    }`}>
      {/* Amp Header */}
      <div className={`border-b px-4 py-3 ${
        hasAnyImpedanceError ? "border-red-200 bg-red-100 dark:border-red-800 dark:bg-red-950/50" : "border-gray-200 bg-gray-100 dark:border-neutral-700 dark:bg-neutral-800"
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-bold text-gray-900 dark:text-gray-200">
              {instance.ampConfig.model}
            </span>
            {instance.ampConfig.mode && (
              <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300">
                {instance.ampConfig.mode}
              </span>
            )}
            <span className="ml-2 text-sm text-gray-500 dark:text-neutral-500">#{instance.id.split("-").pop()}</span>
          </div>
          <div className="flex items-center gap-3">
            {isAtMaxTypes && (
              <span className="text-xs text-amber-600 dark:text-amber-500">
                Max enclosure types
              </span>
            )}
            <div className="text-right">
              <div className={`text-sm font-medium ${getLoadColor(instance.loadPercent)}`}>
                {instance.loadPercent}% load
              </div>
              <div className="text-xs text-gray-500 dark:text-neutral-500">
                {instance.totalEnclosures} enclosure{instance.totalEnclosures !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Outputs Grid - hidden in sales mode */}
      {!salesMode && (
        <div className="p-4">
          {usePhysicalGrouping && physicalGroups ? (
            <div className={`grid gap-2 ${
              physicalOutputCount === 2 ? "grid-cols-2" : physicalOutputCount <= 4 ? "grid-cols-4" : "grid-cols-8"
            }`}>
              {physicalGroups.map((group, i) => (
                <PhysicalOutputCard
                  key={i}
                  outputs={group}
                  physicalIndex={i}
                  salesMode={salesMode}
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  ratedImpedances={instance.ampConfig.ratedImpedances}
                />
              ))}
            </div>
          ) : (
            <div className={`grid gap-2 ${
              ampOutputCount <= 4
                ? "grid-cols-4"
                : "grid-cols-8"
            }`}>
              {instance.outputs.map((output) => (
                <OutputCard
                  key={output.outputIndex}
                  output={output}
                  ampOutputCount={ampOutputCount}
                  salesMode={salesMode}
                  channelTypes={instance.ampConfig.channelTypes}
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  ratedImpedances={instance.ampConfig.ratedImpedances}
                />
              ))}
            </div>
          )}
          {hasAboveRatedOutput && (
            <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <svg className="h-3.5 w-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
              </svg>
              Add 1 more enclosure for minimum recommended load
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a single zone's solver results */
function ZoneSolutionSection({ solution, salesMode, cableGaugeMm2, useFeet }: { solution: SolverSolution; salesMode: boolean; cableGaugeMm2: number; useFeet: boolean }) {
  if (!solution.success) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950/40">
        <h3 className="mb-2 font-bold text-red-800 dark:text-red-500">Cannot Calculate</h3>
        <p className="text-red-700 dark:text-red-400">{solution.errorMessage}</p>
      </div>
    );
  }

  const impedanceErrors = getImpedanceErrors(solution);
  const hasErrors = impedanceErrors.length > 0;

  return (
    <div className="space-y-6">
      {/* Impedance Error Banner */}
      {hasErrors && (
        <div className="rounded-lg border border-red-300 bg-red-100 p-4 dark:border-red-800 dark:bg-red-950/40">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <h4 className="font-bold text-red-800 dark:text-red-500">Impedance Error</h4>
              <p className="text-sm text-red-700 dark:text-red-400">
                {impedanceErrors.length} output{impedanceErrors.length !== 1 ? "s have" : " has"} impedance
                below the minimum {MIN_IMPEDANCE_OHMS}Ω threshold. This configuration is not safe.
              </p>
              <ul className="mt-2 text-xs text-red-600 dark:text-red-500">
                {impedanceErrors.map((err, i) => (
                  <li key={i}>
                    {err.ampId} Output {err.outputIndex + 1}: {err.impedanceOhms}Ω
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Summary Card */}
      <div className={`rounded-lg border p-4 ${
        hasErrors
          ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
          : "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
      }`}>
        <div>
          <h3 className={`mb-3 font-bold ${hasErrors ? "text-amber-800 dark:text-amber-500" : "text-green-800 dark:text-green-500"}`}>
            {hasErrors ? "Configuration (with errors)" : "Recommended Configuration"}
          </h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className={hasErrors ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500"}>Total Amplifiers</div>
              <div className={`text-2xl font-bold ${hasErrors ? "text-amber-900 dark:text-amber-400" : "text-green-900 dark:text-green-400"}`}>
                {solution.summary.totalAmplifiers}
              </div>
            </div>
            <div>
              <div className={hasErrors ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500"}>Enclosures Allocated</div>
              <div className={`text-2xl font-bold ${hasErrors ? "text-amber-900 dark:text-amber-400" : "text-green-900 dark:text-green-400"}`}>
                {solution.summary.totalEnclosuresAllocated}
              </div>
            </div>
          </div>
          <div className={`mt-3 border-t pt-3 text-sm ${
            hasErrors ? "border-amber-200 text-amber-700 dark:border-amber-800 dark:text-amber-400" : "border-green-200 text-green-700 dark:border-green-800 dark:text-green-400"
          }`}>
            <span className="font-medium">Amp Types: </span>
            {solution.summary.ampConfigsUsed.map((c, i) => (
              <span key={c.key}>
                {i > 0 && ", "}
                {c.model}
                {c.mode && ` (${c.mode})`}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Individual Amp Cards */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-neutral-400">
          Amplifier Allocation Detail
        </h3>
        {salesMode ? (
          (() => {
            const grouped = new Map<string, AmpInstance[]>();
            for (const instance of solution.ampInstances) {
              const key = instance.ampConfig.key;
              if (!grouped.has(key)) {
                grouped.set(key, []);
              }
              grouped.get(key)!.push(instance);
            }
            return Array.from(grouped.entries()).map(([key, instances]) => (
              <GroupedAmpCard key={key} instances={instances} />
            ));
          })()
        ) : (
          solution.ampInstances.map((instance) => (
            <AmpCard key={instance.id} instance={instance} salesMode={salesMode} cableGaugeMm2={cableGaugeMm2} useFeet={useFeet} />
          ))
        )}
      </div>
    </div>
  );
}

export default function SolverResults({ zoneSolutions, activeZoneId, salesMode = false, cableGaugeMm2 = 2.5, useFeet = true }: SolverResultsProps) {
  // Find the active zone's solution
  const activeZoneSolution = zoneSolutions.find((zs) => zs.zone.id === activeZoneId);
  const activeSolution = activeZoneSolution?.solution ?? null;

  const handleExportPDF = async () => {
    // PDF exports ALL zones
    await generatePDFReport({ zoneSolutions });
  };

  if (!activeSolution) {
    return (
      <div className="space-y-6">
        <div className="flex justify-end">
          <button
            onClick={handleExportPDF}
            disabled={!zoneSolutions.some((zs) => zs.solution !== null)}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-700 dark:hover:bg-neutral-600"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export PDF
          </button>
        </div>
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-neutral-700 dark:text-neutral-500">
          <p>Add enclosures to see amplifier recommendations.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Export Button */}
      <div className="flex justify-end">
        <button
          onClick={handleExportPDF}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-neutral-700 dark:hover:bg-neutral-600"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export PDF
        </button>
      </div>

      {/* Active Zone Results */}
      <ZoneSolutionSection
        solution={activeSolution}
        salesMode={salesMode}
        cableGaugeMm2={cableGaugeMm2}
        useFeet={useFeet}
      />
    </div>
  );
}
