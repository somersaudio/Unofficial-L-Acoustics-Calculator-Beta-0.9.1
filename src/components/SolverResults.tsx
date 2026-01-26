import React from "react";
import type { SolverSolution, AmpInstance, OutputAllocation, EnclosureRequest, ChannelTypes } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS } from "../types";
import { getImpedanceErrors } from "../solver/ampSolver";
import { generatePDFReport } from "../utils/pdfExport";

interface SolverResultsProps {
  solution: SolverSolution | null;
  requests: EnclosureRequest[];
  salesMode?: boolean;
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

function OutputCard({ output, ampOutputCount, salesMode = false, channelTypes }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; channelTypes?: ChannelTypes }) {
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
      <div className={`${is16Channel ? "" : "mb-1"} font-medium text-gray-700 dark:text-neutral-400`}>{outputLabel}</div>
      {hasLoad ? (
        <>
          <div className={is16Channel ? "" : "space-y-1"}>
            {output.enclosures.map((entry, i) => {
              // Hide enclosure name for L2/L2D on 16-channel amps (they're implied by channel type)
              const isL2Type = entry.enclosure.enclosure === "L2 / L2D";
              const hideEnclosureName = is16Channel && isL2Type;
              return hideEnclosureName ? null : (
                <div key={i} className="text-gray-900 dark:text-gray-200">
                  {entry.count}x {entry.enclosure.enclosure}
                </div>
              );
            })}
          </div>
          {!salesMode && (
            <div
              className={`${is16Channel ? "mt-0.5 pt-0.5" : "mt-2 pt-1"} border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"} ${getImpedanceColor(
                output.impedanceOhms,
                output.minImpedanceOverride
              )}`}
            >
              {output.impedanceOhms === Infinity
                ? "No load"
                : `${output.impedanceOhms}Ω`}
              {hasImpedanceError && (
                <span className="ml-1 text-red-600 dark:text-red-500">ERROR</span>
              )}
            </div>
          )}
        </>
      ) : (
        // For 16-channel amps, show nominal impedance with same styling as loaded outputs; for 4-output amps, show "Empty"
        is16Channel && nominalImpedance && !salesMode ? (
          <div className={`${is16Channel ? "mt-0.5 pt-0.5" : "mt-2 pt-1"} border-t border-gray-200 dark:border-neutral-700 text-green-600 dark:text-green-500`}>
            {nominalImpedance}Ω
          </div>
        ) : !is16Channel ? (
          <div className="text-gray-400 dark:text-neutral-600 italic">Empty</div>
        ) : null
      )}
    </div>
  );
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

function AmpCard({ instance, salesMode = false }: { instance: AmpInstance; salesMode?: boolean }) {
  const ampOutputCount = instance.ampConfig.outputs;
  const hasAnyImpedanceError = !salesMode && instance.outputs.some(
    (o) => o.impedanceOhms < (o.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && o.impedanceOhms !== Infinity
  );
  const enclosureTypeCount = countEnclosureTypes(instance);
  const isAtMaxTypes = enclosureTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP;

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
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SolverResults({ solution, requests, salesMode = false }: SolverResultsProps) {
  if (!solution) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-neutral-700 dark:text-neutral-500">
        <p>Add enclosures to see amplifier recommendations.</p>
      </div>
    );
  }

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

  const handleExportPDF = async () => {
    await generatePDFReport({ solution, requests });
  };

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
        <div className="flex items-center justify-between">
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

          {/* Export Button */}
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
      </div>

      {/* Individual Amp Cards */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-neutral-400">
          Amplifier Allocation Detail
        </h3>
        {salesMode ? (
          // Group amps by config key for sales mode
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
            <AmpCard key={instance.id} instance={instance} salesMode={salesMode} />
          ))
        )}
      </div>
    </div>
  );
}
