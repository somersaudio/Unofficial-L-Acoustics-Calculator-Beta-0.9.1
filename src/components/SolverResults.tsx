import React from "react";
import type { SolverSolution, AmpInstance, OutputAllocation, EnclosureRequest } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS } from "../types";
import { getImpedanceErrors } from "../solver/ampSolver";
import { generatePDFReport } from "../utils/pdfExport";

interface SolverResultsProps {
  solution: SolverSolution | null;
  requests: EnclosureRequest[];
}

function getImpedanceColor(impedance: number): string {
  if (impedance === Infinity) return "text-gray-400";
  if (impedance < HARD_FLOOR_IMPEDANCE) return "text-red-600 font-bold";
  if (impedance < MIN_IMPEDANCE_OHMS) return "text-red-500";
  return "text-green-600";
}

function getLoadColor(loadPercent: number): string {
  if (loadPercent > 100) return "text-red-600";
  if (loadPercent > 80) return "text-amber-600";
  return "text-green-600";
}

function OutputCard({ output, ampOutputCount }: { output: OutputAllocation; ampOutputCount: number }) {
  const hasLoad = output.totalEnclosures > 0;
  const outputLabel = ampOutputCount === 16
    ? `Ch ${output.outputIndex + 1}`
    : `Output ${output.outputIndex + 1}`;
  const hasImpedanceError = output.impedanceOhms < HARD_FLOOR_IMPEDANCE && output.impedanceOhms !== Infinity;

  return (
    <div
      className={`rounded border p-2 text-xs ${
        hasImpedanceError
          ? "border-red-300 bg-red-50"
          : hasLoad
          ? "border-blue-200 bg-blue-50"
          : "border-gray-200 bg-gray-50"
      }`}
    >
      <div className="mb-1 font-medium text-gray-700">{outputLabel}</div>
      {hasLoad ? (
        <>
          <div className="space-y-1">
            {output.enclosures.map((entry, i) => (
              <div key={i} className="text-gray-900">
                {entry.count}x {entry.enclosure.enclosure}
              </div>
            ))}
          </div>
          <div
            className={`mt-2 border-t ${hasImpedanceError ? "border-red-200" : "border-blue-200"} pt-1 ${getImpedanceColor(
              output.impedanceOhms
            )}`}
          >
            {output.impedanceOhms === Infinity
              ? "No load"
              : `${output.impedanceOhms}Ω`}
            {hasImpedanceError && (
              <span className="ml-1 text-red-600">ERROR</span>
            )}
          </div>
        </>
      ) : (
        <div className="text-gray-400 italic">Empty</div>
      )}
    </div>
  );
}

function AmpCard({ instance }: { instance: AmpInstance }) {
  const ampOutputCount = instance.ampConfig.outputs;
  const hasAnyImpedanceError = instance.outputs.some(
    (o) => o.impedanceOhms < HARD_FLOOR_IMPEDANCE && o.impedanceOhms !== Infinity
  );

  return (
    <div className={`rounded-lg border shadow-sm ${
      hasAnyImpedanceError ? "border-red-300 bg-red-50" : "border-gray-300 bg-white"
    }`}>
      {/* Amp Header */}
      <div className={`border-b px-4 py-3 ${
        hasAnyImpedanceError ? "border-red-200 bg-red-100" : "border-gray-200 bg-gray-100"
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-bold text-gray-900">
              {instance.ampConfig.model}
            </span>
            {instance.ampConfig.mode && (
              <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {instance.ampConfig.mode}
              </span>
            )}
            <span className="ml-2 text-sm text-gray-500">#{instance.id.split("-").pop()}</span>
          </div>
          <div className="text-right">
            <div className={`text-sm font-medium ${getLoadColor(instance.loadPercent)}`}>
              {instance.loadPercent}% load
            </div>
            <div className="text-xs text-gray-500">
              {instance.totalEnclosures} enclosure{instance.totalEnclosures !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      </div>

      {/* Outputs Grid */}
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
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SolverResults({ solution, requests }: SolverResultsProps) {
  if (!solution) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500">
        <p>Add enclosures to see amplifier recommendations.</p>
      </div>
    );
  }

  if (!solution.success) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <h3 className="mb-2 font-bold text-red-800">Cannot Calculate</h3>
        <p className="text-red-700">{solution.errorMessage}</p>
      </div>
    );
  }

  const impedanceErrors = getImpedanceErrors(solution);
  const hasErrors = impedanceErrors.length > 0;

  const handleExportPDF = () => {
    generatePDFReport({ solution, requests });
  };

  return (
    <div className="space-y-6">
      {/* Impedance Error Banner */}
      {hasErrors && (
        <div className="rounded-lg border border-red-300 bg-red-100 p-4">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <h4 className="font-bold text-red-800">Impedance Error</h4>
              <p className="text-sm text-red-700">
                {impedanceErrors.length} output{impedanceErrors.length !== 1 ? "s have" : " has"} impedance
                below the minimum {MIN_IMPEDANCE_OHMS}Ω threshold. This configuration is not safe.
              </p>
              <ul className="mt-2 text-xs text-red-600">
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
          ? "border-amber-200 bg-amber-50"
          : "border-green-200 bg-green-50"
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className={`mb-3 font-bold ${hasErrors ? "text-amber-800" : "text-green-800"}`}>
              {hasErrors ? "Configuration (with errors)" : "Recommended Configuration"}
            </h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className={hasErrors ? "text-amber-600" : "text-green-600"}>Total Amplifiers</div>
                <div className={`text-2xl font-bold ${hasErrors ? "text-amber-900" : "text-green-900"}`}>
                  {solution.summary.totalAmplifiers}
                </div>
              </div>
              <div>
                <div className={hasErrors ? "text-amber-600" : "text-green-600"}>Enclosures Allocated</div>
                <div className={`text-2xl font-bold ${hasErrors ? "text-amber-900" : "text-green-900"}`}>
                  {solution.summary.totalEnclosuresAllocated}
                </div>
              </div>
            </div>
            <div className={`mt-3 border-t pt-3 text-sm ${
              hasErrors ? "border-amber-200 text-amber-700" : "border-green-200 text-green-700"
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
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
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
        <h3 className="text-sm font-medium text-gray-700">
          Amplifier Allocation Detail
        </h3>
        {solution.ampInstances.map((instance) => (
          <AmpCard key={instance.id} instance={instance} />
        ))}
      </div>
    </div>
  );
}
