import React, { useEffect, useState, useMemo } from "react";
import type { DataLoadResult, EnclosureRequest, SolverSolution, AmpConfig } from "../types";
import EnclosureSelector from "./EnclosureSelector";
import SolverResults from "./SolverResults";
import { solveAmplifierAllocation } from "../solver/ampSolver";

type AppState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NonNullable<DataLoadResult["data"]> };

export default function App() {
  const [state, setState] = useState<AppState>({ status: "loading" });
  const [requests, setRequests] = useState<EnclosureRequest[]>([]);
  const [disabledAmps, setDisabledAmps] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function loadData() {
      try {
        const result = await window.electronAPI.getAppData();

        if (!result.success || !result.data) {
          const errorMsg = result.errors
            .map((e) => `${e.file}: ${e.message}`)
            .join("\n");
          setState({ status: "error", message: errorMsg });
          return;
        }

        setState({ status: "ready", data: result.data });
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    loadData();
  }, []);

  // Filter amp configs based on disabled amps
  const enabledAmpConfigs = useMemo<AmpConfig[]>(() => {
    if (state.status !== "ready") return [];
    return state.data.ampConfigs.filter((config) => !disabledAmps.has(config.model));
  }, [state, disabledAmps]);

  // Compute solution whenever requests or enabled amps change
  const solution = useMemo<SolverSolution | null>(() => {
    if (state.status !== "ready") return null;
    if (requests.length === 0) return null;

    return solveAmplifierAllocation(requests, enabledAmpConfigs);
  }, [state, requests, enabledAmpConfigs]);

  // Get unique amp models for the footer toggle
  const ampModels = useMemo<string[]>(() => {
    if (state.status !== "ready") return [];
    const models = new Set(state.data.amplifiers.amplifiers.map((a) => a.amplifier));
    return Array.from(models);
  }, [state]);

  const toggleAmp = (model: string) => {
    setDisabledAmps((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(model)) {
        newSet.delete(model);
      } else {
        newSet.add(model);
      }
      return newSet;
    });
  };

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100">
        <div className="text-lg text-gray-600">Loading data...</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 p-8">
        <div className="max-w-lg rounded-lg bg-white p-6 shadow-lg">
          <h1 className="mb-4 text-xl font-bold text-red-600">
            Failed to Load Data
          </h1>
          <pre className="whitespace-pre-wrap rounded bg-gray-100 p-4 text-sm text-gray-800">
            {state.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="flex h-screen flex-col bg-gray-100">
      {/* Header */}
      <header className="bg-blue-800 px-6 py-4 text-white shadow">
        <h1 className="text-xl font-bold">L-Acoustic Amp Calc</h1>
        <p className="text-sm text-blue-200">
          Amplifier Calculator for Speaker Configurations
        </p>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Left Panel - Enclosure Selection */}
        <section className="w-1/2 overflow-auto border-r border-gray-300 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">
            Select Enclosures
          </h2>

          <EnclosureSelector
            enclosures={data.enclosures.enclosures}
            ampConfigs={enabledAmpConfigs}
            requests={requests}
            onRequestsChange={setRequests}
          />
        </section>

        {/* Right Panel - Amplifier Recommendation */}
        <section className="w-1/2 overflow-auto bg-gray-50 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">
            Recommended Amplifiers
          </h2>

          <SolverResults solution={solution} requests={requests} />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-300 bg-white px-6 py-3">
        <div className="flex items-center justify-between">
          {/* Amplifier Toggles */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600">Available Amps:</span>
            <div className="flex gap-1">
              {ampModels.map((model) => {
                const isDisabled = disabledAmps.has(model);
                return (
                  <button
                    key={model}
                    onClick={() => toggleAmp(model)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      isDisabled
                        ? "bg-gray-200 text-gray-400 line-through"
                        : "bg-blue-100 text-blue-800 hover:bg-blue-200"
                    }`}
                    title={isDisabled ? `Enable ${model}` : `Disable ${model}`}
                  >
                    {model}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Solution Summary */}
          <span className="text-xs text-gray-500">
            {requests.length > 0 && solution?.success && (
              <>
                Solution: {solution.summary.totalAmplifiers} amplifier
                {solution.summary.totalAmplifiers !== 1 ? "s" : ""}
              </>
            )}
            {requests.length > 0 && !solution?.success && solution?.errorMessage && (
              <span className="text-red-500">No valid configuration</span>
            )}
          </span>
        </div>
      </footer>
    </div>
  );
}
