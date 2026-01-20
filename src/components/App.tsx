import React, { useEffect, useState, useMemo } from "react";
import type { DataLoadResult, EnclosureRequest, SolverSolution, AmpConfig } from "../types";
import EnclosureSelector from "./EnclosureSelector";
import SolverResults from "./SolverResults";
import { solveAmplifierAllocation } from "../solver/ampSolver";

type AppState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NonNullable<DataLoadResult["data"]> };

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
  );
}

export default function App() {
  const [state, setState] = useState<AppState>({ status: "loading" });
  const [requests, setRequests] = useState<EnclosureRequest[]>([]);
  const [disabledAmps, setDisabledAmps] = useState<Set<string>>(new Set());
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("darkMode");
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => {
    localStorage.setItem("darkMode", JSON.stringify(darkMode));
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

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
      <div className="flex h-screen items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-lg text-gray-600 dark:text-gray-300">Loading data...</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 p-8 dark:bg-gray-900">
        <div className="max-w-lg rounded-lg bg-white p-6 shadow-lg dark:bg-gray-800">
          <h1 className="mb-4 text-xl font-bold text-red-600 dark:text-red-400">
            Failed to Load Data
          </h1>
          <pre className="whitespace-pre-wrap rounded bg-gray-100 p-4 text-sm text-gray-800 dark:bg-gray-700 dark:text-gray-200">
            {state.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="flex h-screen flex-col bg-gray-100 dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between bg-blue-800 px-6 py-4 text-white shadow dark:bg-gray-800">
        <div>
          <h1 className="text-xl font-bold">L-Acoustic Amp Calc</h1>
          <p className="text-sm text-blue-200 dark:text-gray-400">
            Amplifier Calculator for Speaker Configurations
          </p>
        </div>
        <button
          onClick={() => setDarkMode(!darkMode)}
          className="rounded-lg p-2 hover:bg-blue-700 dark:hover:bg-gray-700 transition-colors"
          title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        >
          {darkMode ? (
            <SunIcon className="h-5 w-5 text-yellow-300" />
          ) : (
            <MoonIcon className="h-5 w-5 text-blue-200" />
          )}
        </button>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Left Panel - Enclosure Selection */}
        <section className="w-1/2 overflow-auto border-r border-gray-300 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">
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
        <section className="w-1/2 overflow-auto bg-gray-50 p-6 dark:bg-gray-850 dark:bg-gray-900">
          <h2 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">
            Recommended Amplifiers
          </h2>

          <SolverResults solution={solution} requests={requests} />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-300 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between">
          {/* Amplifier Toggles */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Available Amps:</span>
            <div className="flex gap-1">
              {ampModels.map((model) => {
                const isDisabled = disabledAmps.has(model);
                return (
                  <button
                    key={model}
                    onClick={() => toggleAmp(model)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      isDisabled
                        ? "bg-gray-200 text-gray-400 line-through dark:bg-gray-700 dark:text-gray-500"
                        : "bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
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
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {requests.length > 0 && solution?.success && (
              <>
                Solution: {solution.summary.totalAmplifiers} amplifier
                {solution.summary.totalAmplifiers !== 1 ? "s" : ""}
              </>
            )}
            {requests.length > 0 && !solution?.success && solution?.errorMessage && (
              <span className="text-red-500 dark:text-red-400">No valid configuration</span>
            )}
          </span>
        </div>
      </footer>
    </div>
  );
}
