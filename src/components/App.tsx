import React, { useEffect, useState, useMemo, useCallback } from "react";
import type { DataLoadResult, Zone, ZoneWithSolution, ProjectFile, AmpInstance } from "../types";
import { CABLE_GAUGES } from "../types";
import EnclosureSelector, { type LockedAmpEnclosureInfo } from "./EnclosureSelector";
import SolverResults from "./SolverResults";
import type { EnclosureMoveResult } from "./EnclosureDragDrop";
import ZoneTabBar from "./ZoneTabBar";
import MatrixRain from "./MatrixRain";
import { solveAmplifierAllocation } from "../solver/ampSolver";
import { serializeZones, deserializeZones } from "../utils/zoneSerializer";
import { getLowestFrequency } from "../utils/frequencyData";
import { generatePDFReport } from "../utils/pdfExport";
import lacousticsLogo from "../assets/lacoustics-logo.png";
import subHemisphere from "../assets/sub-hemisphere.png";

// Matrix rain sentences - L-Acoustics themed phrases
const MATRIX_SENTENCES = [
  "L-ACOUSTICS AMPLIFICATION",
  "LA12X POWERING THE FUTURE",
  "KARA II LINE SOURCE ARRAY",
  "K2 LARGE FORMAT WST",
  "SYVA COLINEAR SOURCE",
  "IMPEDANCE MATTERS",
  "PROFESSIONAL AUDIO",
  "SOUND EXCELLENCE",
  "DRIVEN BY INNOVATION",
  "AMPLIFIED PERFECTION",
  "KS28 SUBWOOFER POWER",
  "A SERIES INSTALLATION",
  "X SERIES COAXIAL",
  "WAVEFRONT SCULPTURE",
  "SOUNDVISION DESIGN",
  "CONTOUR AMBIENT SYSTEM",
];

type AppState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NonNullable<DataLoadResult["data"]> };

const DEFAULT_DISABLED_AMPS = ["LA4", "LA2Xi", "LA7.16(i)"];

function createDefaultZone(): Zone {
  return {
    id: crypto.randomUUID(),
    name: "Main",
    requests: [],
    disabledAmps: new Set(DEFAULT_DISABLED_AMPS),
    lockedAmpInstances: [],
  };
}

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

/** Frequency Hemisphere visual - shows lowest frequency in the zone (flipped, for footer) */
function FrequencyHemisphere({ frequency }: { frequency: number | null }) {
  if (frequency === null) return null;

  return (
    <div className="relative flex flex-col items-center">
      {/* Hemisphere image - flipped upside down */}
      <div className="relative" style={{ width: 80, height: 40 }}>
        <img
          src={subHemisphere}
          alt="Frequency indicator"
          className="w-full h-full object-cover object-top"
          style={{ mixBlendMode: "lighten", transform: "scaleY(-1)" }}
        />
        {/* Frequency text overlay */}
        <span
          className="absolute inset-x-0 flex justify-center font-bold"
          style={{
            fontSize: 18,
            color: "#000000",
            top: -6,
          }}
        >
          {frequency}Hz
        </span>
      </div>
    </div>
  );
}

function BugReportButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  const handleSend = () => {
    if (!message.trim()) return;
    const mailto = `mailto:Admin@somersaudio.com?subject=${encodeURIComponent("Bug Report – L-Acoustics Amp Calc")}&body=${encodeURIComponent(message)}`;
    window.open(mailto, "_blank");
    setMessage("");
    setOpen(false);
  };

  return (
    <div className="relative">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-gray-300 bg-white p-4 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Report a Bug</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">&times;</button>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the issue..."
            rows={4}
            className="w-full resize-none rounded border border-gray-300 bg-gray-50 p-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-200 dark:placeholder-neutral-500"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim()}
            className="mt-2 w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            Send
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 shadow transition-colors hover:bg-gray-300 dark:bg-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-600"
      >
        Report Bug
      </button>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<AppState>({ status: "loading" });
  const [zones, setZones] = useState<Zone[]>([createDefaultZone()]);
  const [activeZoneId, setActiveZoneId] = useState<string>(zones[0].id);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("darkMode");
    return saved ? JSON.parse(saved) : true;
  });
  const [salesMode, setSalesMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("salesMode");
    return saved ? JSON.parse(saved) : false;
  });
  const [cableGaugeMm2, setCableGaugeMm2] = useState<number>(() => {
    const saved = localStorage.getItem("cableGaugeMm2");
    return saved ? JSON.parse(saved) : 2.5;
  });
  const [useFeet, setUseFeet] = useState<boolean>(() => {
    const saved = localStorage.getItem("useFeet");
    return saved ? JSON.parse(saved) : true;
  });
  const [matrixEnabled, setMatrixEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem("matrixEnabled");
    return saved ? JSON.parse(saved) : true;
  });
  const [rackMode, setRackMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("rackMode");
    return saved ? JSON.parse(saved) : false;
  });
  // Restore zones from localStorage once data is loaded
  const [zonesRestored, setZonesRestored] = useState(false);

  useEffect(() => {
    localStorage.setItem("darkMode", JSON.stringify(darkMode));
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem("salesMode", JSON.stringify(salesMode));
  }, [salesMode]);

  useEffect(() => {
    localStorage.setItem("cableGaugeMm2", JSON.stringify(cableGaugeMm2));
  }, [cableGaugeMm2]);

  useEffect(() => {
    localStorage.setItem("useFeet", JSON.stringify(useFeet));
  }, [useFeet]);

  useEffect(() => {
    localStorage.setItem("matrixEnabled", JSON.stringify(matrixEnabled));
  }, [matrixEnabled]);

  useEffect(() => {
    localStorage.setItem("rackMode", JSON.stringify(rackMode));
  }, [rackMode]);

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

  // Restore zones from localStorage after data is loaded
  useEffect(() => {
    if (state.status !== "ready" || zonesRestored) return;
    setZonesRestored(true);

    try {
      const saved = localStorage.getItem("zones");
      if (saved) {
        const parsed = JSON.parse(saved);
        const restored = deserializeZones(parsed, state.data.enclosures.enclosures, state.data.ampConfigs);
        if (restored.length > 0) {
          setZones(restored);
          setActiveZoneId(restored[0].id);
        }
      }
    } catch {
      // Corrupt localStorage data — keep default zone
    }
  }, [state, zonesRestored]);

  // Safety: recreate default zone if zones array is ever empty
  useEffect(() => {
    if (zones.length === 0) {
      const def = createDefaultZone();
      setZones([def]);
      setActiveZoneId(def.id);
    }
  }, [zones]);

  // Auto-save zones to localStorage
  useEffect(() => {
    if (!zonesRestored) return;
    localStorage.setItem("zones", JSON.stringify(serializeZones(zones)));
  }, [zones, zonesRestored]);

  // Zone mutation helpers
  const updateZone = useCallback((zoneId: string, updater: (zone: Zone) => Zone) => {
    setZones((prev) => prev.map((z) => (z.id === zoneId ? updater(z) : z)));
  }, []);

  const addZone = useCallback(() => {
    const newZone: Zone = {
      id: crypto.randomUUID(),
      name: `Zone ${String.fromCharCode(65 + zones.length)}`,
      requests: [],
      disabledAmps: new Set(DEFAULT_DISABLED_AMPS),
      lockedAmpInstances: [],
    };
    setZones((prev) => [...prev, newZone]);
    setActiveZoneId(newZone.id);
  }, [zones.length]);

  const removeZone = useCallback((zoneId: string) => {
    setZones((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((z) => z.id !== zoneId);
      return filtered;
    });
    setActiveZoneId((prevId) => {
      if (prevId === zoneId) {
        const remaining = zones.filter((z) => z.id !== zoneId);
        return remaining.length > 0 ? remaining[0].id : prevId;
      }
      return prevId;
    });
  }, [zones]);

  const renameZone = useCallback((zoneId: string, name: string) => {
    updateZone(zoneId, (z) => ({ ...z, name }));
  }, [updateZone]);

  // File save/load
  const handleSaveProject = useCallback(async () => {
    const project: ProjectFile = {
      version: 1,
      zones: serializeZones(zones),
      settings: { darkMode, salesMode, rackMode, cableGaugeMm2, useFeet },
    };
    await window.electronAPI.saveProject(JSON.stringify(project, null, 2));
  }, [zones, darkMode, salesMode, rackMode, cableGaugeMm2, useFeet]);

  const handleLoadProject = useCallback(async () => {
    if (state.status !== "ready") return;
    const result = await window.electronAPI.loadProject();
    if (!result.success || !result.data) return;
    try {
      const project: ProjectFile = JSON.parse(result.data);
      const restored = deserializeZones(project.zones, state.data.enclosures.enclosures, state.data.ampConfigs);
      if (restored.length > 0) {
        setZones(restored);
        setActiveZoneId(restored[0].id);
      }
      if (project.settings) {
        setDarkMode(project.settings.darkMode);
        setSalesMode(project.settings.salesMode);
        setRackMode(project.settings.rackMode ?? false);
        setCableGaugeMm2(project.settings.cableGaugeMm2);
        setUseFeet(project.settings.useFeet);
      }
    } catch {
      // Invalid project file
    }
  }, [state]);

  // Derive active zone
  const activeZone = zones.find((z) => z.id === activeZoneId) ?? zones[0];

  // Compute solver solutions for all zones
  const zoneSolutions = useMemo<ZoneWithSolution[]>(() => {
    if (state.status !== "ready") return [];
    return zones.map((zone) => {
      const enabledAmpConfigs = state.data.ampConfigs.filter(
        (config) => !zone.disabledAmps.has(config.model)
      );

      // Calculate enclosures already allocated to locked amps
      // For multi-channel enclosures, only count on the primary channel to avoid double-counting
      const lockedEnclosureCounts = new Map<string, number>();
      for (const lockedAmp of zone.lockedAmpInstances) {
        const seenMultiChannel = new Set<string>();
        for (const output of lockedAmp.outputs) {
          for (const entry of output.enclosures) {
            const name = entry.enclosure.enclosure;
            const channelsPerUnit = entry.enclosure.signal_channels?.length ?? 1;

            if (channelsPerUnit > 1) {
              // Multi-channel enclosure: only count on primary channel (to avoid double-counting)
              const groupIdx = Math.floor(output.outputIndex / channelsPerUnit);
              const groupKey = `${name}_${groupIdx}`;
              if (seenMultiChannel.has(groupKey)) continue;
              seenMultiChannel.add(groupKey);
            }

            lockedEnclosureCounts.set(name, (lockedEnclosureCounts.get(name) ?? 0) + entry.count);
          }
        }
      }

      // Subtract locked enclosures from requests to get remaining
      const remainingRequests = zone.requests
        .map((req) => {
          const lockedCount = lockedEnclosureCounts.get(req.enclosure.enclosure) ?? 0;
          const remaining = req.quantity - lockedCount;
          if (remaining <= 0) return null;
          return { ...req, quantity: remaining };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // Solve for remaining enclosures only
      const solverResult =
        remainingRequests.length > 0
          ? solveAmplifierAllocation(remainingRequests, enabledAmpConfigs)
          : null;

      // Combine locked amps with newly solved amps
      // Put solved amps first (they represent "remaining" allocations), locked amps at end
      let solution: typeof solverResult = null;
      if (zone.lockedAmpInstances.length > 0 || solverResult) {
        const lockedAmps = zone.lockedAmpInstances;
        const solvedAmps = solverResult?.ampInstances ?? [];
        const allAmps = [...solvedAmps, ...lockedAmps];

        // Calculate summary
        const totalEnclosuresAllocated = allAmps.reduce((sum, amp) => sum + amp.totalEnclosures, 0);
        const ampConfigsUsed = [...new Map(allAmps.map((a) => [a.ampConfig.key, a.ampConfig])).values()];
        const maxPowerRank = Math.max(...ampConfigsUsed.map((c) => c.powerRank), 0);

        solution = {
          success: solverResult?.success ?? true,
          errorMessage: solverResult?.errorMessage,
          ampInstances: allAmps,
          summary: {
            totalAmplifiers: allAmps.length,
            totalEnclosuresAllocated,
            ampConfigsUsed,
            maxPowerRank,
          },
        };
      }

      return { zone, solution, enabledAmpConfigs };
    });
  }, [state, zones]);

  // Get active zone's enabled amp configs for the EnclosureSelector
  const activeZoneSolution = zoneSolutions.find((zs) => zs.zone.id === activeZoneId);
  const activeEnabledAmpConfigs = activeZoneSolution?.enabledAmpConfigs ?? [];

  // Calculate locked enclosure counts for the active zone
  // For multi-channel enclosures, only count on the primary channel to avoid double-counting
  const activeLockedEnclosureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lockedAmp of activeZone.lockedAmpInstances) {
      const seenMultiChannel = new Set<string>();
      for (const output of lockedAmp.outputs) {
        for (const entry of output.enclosures) {
          const name = entry.enclosure.enclosure;
          const channelsPerUnit = entry.enclosure.signal_channels?.length ?? 1;

          if (channelsPerUnit > 1) {
            // Multi-channel enclosure: only count on primary channel (to avoid double-counting)
            const groupIdx = Math.floor(output.outputIndex / channelsPerUnit);
            const groupKey = `${name}_${groupIdx}`;
            if (seenMultiChannel.has(groupKey)) continue;
            seenMultiChannel.add(groupKey);
          }

          counts.set(name, (counts.get(name) ?? 0) + entry.count);
        }
      }
    }
    return counts;
  }, [activeZone.lockedAmpInstances]);

  // Build detailed locked enclosure info per amp/rack for EnclosureSelector display
  const activeLockedAmpEnclosures = useMemo<LockedAmpEnclosureInfo[]>(() => {
    // Group locked amps by rackGroupId (for LA-RAK) or individual amp
    const rackGroups = new Map<string, AmpInstance[]>();

    for (const amp of activeZone.lockedAmpInstances) {
      if (amp.ampConfig.key === "LA12X" && rackMode) {
        // Group LA12X by rackGroupId
        const groupId = amp.rackGroupId ?? amp.id;
        if (!rackGroups.has(groupId)) {
          rackGroups.set(groupId, []);
        }
        rackGroups.get(groupId)!.push(amp);
      } else {
        // Individual amp
        rackGroups.set(amp.id, [amp]);
      }
    }

    // Build the info array
    const result: LockedAmpEnclosureInfo[] = [];
    let rackNumber = 1;
    const ampNumbers = new Map<string, number>(); // model -> next number

    for (const [groupId, amps] of rackGroups) {
      const enclosures = new Map<string, number>();

      for (const amp of amps) {
        const seenMultiChannel = new Set<string>();
        for (const output of amp.outputs) {
          for (const entry of output.enclosures) {
            const name = entry.enclosure.enclosure;
            const channelsPerUnit = entry.enclosure.signal_channels?.length ?? 1;

            if (channelsPerUnit > 1) {
              const groupIdx = Math.floor(output.outputIndex / channelsPerUnit);
              const groupKey = `${name}_${groupIdx}`;
              if (seenMultiChannel.has(groupKey)) continue;
              seenMultiChannel.add(groupKey);
            }

            enclosures.set(name, (enclosures.get(name) ?? 0) + entry.count);
          }
        }
      }

      // Determine label
      let label: string;
      if (amps[0].ampConfig.key === "LA12X" && rackMode) {
        label = `LA-RAK #${rackNumber++}`;
      } else {
        const model = amps[0].ampConfig.model;
        const num = (ampNumbers.get(model) ?? 0) + 1;
        ampNumbers.set(model, num);
        label = `${model} #${num}`;
      }

      result.push({
        ampLabel: label,
        ampId: groupId,
        enclosures,
      });
    }

    return result;
  }, [activeZone.lockedAmpInstances, rackMode]);

  // Get unique amp models for the footer toggle
  const ampModels = useMemo<string[]>(() => {
    if (state.status !== "ready") return [];
    const models = new Set(state.data.amplifiers.amplifiers.map((a) => a.amplifier));
    return Array.from(models);
  }, [state]);

  const toggleAmp = (model: string) => {
    updateZone(activeZoneId, (zone) => {
      const newSet = new Set(zone.disabledAmps);
      if (newSet.has(model)) {
        newSet.delete(model);
      } else {
        newSet.add(model);
      }
      return { ...zone, disabledAmps: newSet };
    });
  };

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100 dark:bg-black">
        <div className="text-lg text-gray-600 dark:text-gray-400">Loading data...</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 p-8 dark:bg-black">
        <div className="max-w-lg rounded-lg bg-white p-6 shadow-lg dark:bg-neutral-900 dark:border dark:border-neutral-800">
          <h1 className="mb-4 text-xl font-bold text-red-600 dark:text-red-500">
            Failed to Load Data
          </h1>
          <pre className="whitespace-pre-wrap rounded bg-gray-100 p-4 text-sm text-gray-800 dark:bg-neutral-800 dark:text-gray-300">
            {state.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="relative flex h-screen flex-col bg-gray-100 dark:bg-black">
      {/* Matrix Rain Effect - dark mode only, toggleable */}
      {darkMode && matrixEnabled && <MatrixRain sentences={MATRIX_SENTENCES} opacity={1} />}

      {/* Header */}
      <header className={`relative z-10 flex items-center justify-between bg-blue-800 px-6 py-4 text-white shadow dark:border-b dark:border-neutral-800 ${matrixEnabled ? 'dark:bg-black/70' : 'dark:bg-neutral-900'}`}>
        <img
          src={lacousticsLogo}
          alt="L-Acoustics"
          className="h-8"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => generatePDFReport({ zoneSolutions })}
            disabled={!zoneSolutions.some((zs) => zs.solution !== null)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium bg-blue-700 text-blue-200 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 transition-colors"
            title="Export PDF report"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            PDF
          </button>
          <div className="mx-1 h-6 w-px bg-blue-600 dark:bg-neutral-700" />
          <button
            onClick={handleLoadProject}
            className="rounded-lg px-3 py-1.5 text-sm font-medium bg-blue-700 text-blue-200 hover:bg-blue-600 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 transition-colors"
            title="Open project file"
          >
            Open
          </button>
          <button
            onClick={handleSaveProject}
            className="rounded-lg px-3 py-1.5 text-sm font-medium bg-blue-700 text-blue-200 hover:bg-blue-600 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 transition-colors"
            title="Save project file"
          >
            Save
          </button>
          <div className="mx-1 h-6 w-px bg-blue-600 dark:bg-neutral-700" />
          <button
            onClick={() => setSalesMode(!salesMode)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              salesMode
                ? "bg-green-500 text-white hover:bg-green-600"
                : "bg-blue-700 text-blue-200 hover:bg-blue-600 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
            }`}
            title={salesMode ? "Switch to engineer mode" : "Switch to sales mode"}
          >
            {salesMode ? "Sales Mode" : "Engineer Mode"}
          </button>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="rounded-lg p-2 hover:bg-blue-700 dark:hover:bg-neutral-800 transition-colors"
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            {darkMode ? (
              <SunIcon className="h-5 w-5 text-yellow-400" />
            ) : (
              <MoonIcon className="h-5 w-5 text-blue-200" />
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex flex-1 overflow-hidden">
        {/* Left Panel - Enclosure Selection */}
        <section className="w-1/2 flex flex-col overflow-hidden border-r border-gray-300 bg-white dark:border-neutral-800 dark:bg-transparent">
          <ZoneTabBar
            zones={zones}
            activeZoneId={activeZoneId}
            onSelectZone={setActiveZoneId}
            onAddZone={addZone}
            onRemoveZone={removeZone}
            onRenameZone={renameZone}
          />
          <div className={`relative flex-1 overflow-auto p-6 bg-white ${matrixEnabled ? 'dark:bg-black/70' : 'dark:bg-neutral-900'}`}>
            <EnclosureSelector
              enclosures={data.enclosures.enclosures}
              ampConfigs={activeEnabledAmpConfigs}
              requests={activeZone.requests}
              onRequestsChange={(reqs) => updateZone(activeZoneId, (z) => ({ ...z, requests: reqs }))}
              salesMode={salesMode}
              lockedEnclosureCounts={activeLockedEnclosureCounts}
              lockedAmpEnclosures={activeLockedAmpEnclosures}
            />
          </div>
        </section>

        {/* Right Panel - Amplifier Recommendation */}
        <section className="w-1/2 overflow-auto bg-gray-50 p-6 dark:bg-black/70">
          <SolverResults
            zoneSolutions={zoneSolutions}
            activeZoneId={activeZoneId}
            salesMode={salesMode}
            rackMode={rackMode}
            cableGaugeMm2={cableGaugeMm2}
            useFeet={useFeet}
            onAdjustEnclosure={(enclosureName, delta) => {
              updateZone(activeZoneId, (zone) => {
                const idx = zone.requests.findIndex((r) => r.enclosure.enclosure === enclosureName);
                if (idx < 0) return zone;
                const newQuantity = zone.requests[idx].quantity + delta;
                if (newQuantity < 1) return zone;
                const newRequests = [...zone.requests];
                newRequests[idx] = { ...newRequests[idx], quantity: newQuantity };
                return { ...zone, requests: newRequests };
              });
            }}
            onLockAmpInstance={(ampInstance: AmpInstance) => {
              updateZone(activeZoneId, (zone) => ({
                ...zone,
                lockedAmpInstances: [...zone.lockedAmpInstances, ampInstance],
              }));
            }}
            onUnlockAmpInstance={(ampInstanceId: string) => {
              updateZone(activeZoneId, (zone) => ({
                ...zone,
                lockedAmpInstances: zone.lockedAmpInstances.filter((a) => a.id !== ampInstanceId),
              }));
            }}
            onCombineLockedRacks={(ampIds: string[]) => {
              // Assign the same rackGroupId to all specified amps so they appear in one rack
              const newRackGroupId = `rack-${crypto.randomUUID().split("-").pop()}`;
              updateZone(activeZoneId, (zone) => ({
                ...zone,
                lockedAmpInstances: zone.lockedAmpInstances.map((a) =>
                  ampIds.includes(a.id) ? { ...a, rackGroupId: newRackGroupId } : a
                ),
              }));
            }}
            onMoveEnclosure={(move: EnclosureMoveResult) => {
              // Find the active zone's current solution to get amp instances
              const activeZoneSolution = zoneSolutions.find((zs) => zs.zone.id === activeZoneId);
              if (!activeZoneSolution?.solution) return;

              const allInstances = [
                ...activeZoneSolution.zone.lockedAmpInstances,
                ...activeZoneSolution.solution.ampInstances,
              ];

              // Find source and target amp instances
              const sourceAmp = allInstances.find((a) => a.id === move.sourceAmpId);
              const targetAmp = allInstances.find((a) => a.id === move.targetAmpId);
              if (!sourceAmp || !targetAmp) return;

              // Find the enclosure in the source channel
              const sourceOutput = sourceAmp.outputs[move.sourceChannelIndex];
              const enclosureEntry = sourceOutput?.enclosures.find(
                (e) => e.enclosure.enclosure === move.enclosureName
              );
              if (!enclosureEntry || enclosureEntry.count < 1) return;

              // Create modified copies of source and target amps
              const modifyAmpOutput = (
                amp: AmpInstance,
                channelIndex: number,
                enclosureName: string,
                delta: number
              ): AmpInstance => {
                const newOutputs = amp.outputs.map((output, i) => {
                  if (i !== channelIndex) return output;
                  const newEnclosures = output.enclosures
                    .map((e) => {
                      if (e.enclosure.enclosure !== enclosureName) return e;
                      const newCount = e.count + delta;
                      return newCount > 0 ? { ...e, count: newCount } : null;
                    })
                    .filter((e): e is NonNullable<typeof e> => e !== null);

                  // If adding and enclosure doesn't exist yet, add it
                  if (delta > 0 && !newEnclosures.some((e) => e.enclosure.enclosure === enclosureName)) {
                    newEnclosures.push({ enclosure: enclosureEntry.enclosure, count: delta });
                  }

                  const newTotalEnclosures = newEnclosures.reduce((sum, e) => sum + e.count, 0);

                  // Recalculate impedance using per-section impedance for multi-channel enclosures
                  let newImpedance = Infinity;
                  if (newTotalEnclosures > 0 && newEnclosures.length > 0) {
                    let reciprocalSum = 0;
                    for (const e of newEnclosures) {
                      // For multi-channel enclosures, use section impedance for this channel
                      const channelsPerUnit = e.enclosure.signal_channels?.length ?? 1;
                      let sectionZ = e.enclosure.nominal_impedance_ohms;
                      if (channelsPerUnit > 1 && e.enclosure.impedance_sections_ohms) {
                        const posInGroup = output.outputIndex % channelsPerUnit;
                        const signalType = e.enclosure.signal_channels[posInGroup];
                        sectionZ = e.enclosure.impedance_sections_ohms[signalType] ?? sectionZ;
                      }
                      reciprocalSum += e.count / sectionZ;
                    }
                    newImpedance = reciprocalSum > 0 ? Math.round((1 / reciprocalSum) * 10) / 10 : Infinity;
                  }

                  return {
                    ...output,
                    enclosures: newEnclosures,
                    totalEnclosures: newTotalEnclosures,
                    impedanceOhms: newImpedance,
                  };
                });

                const totalEnclosures = newOutputs.reduce((sum, o) => sum + o.totalEnclosures, 0);
                return { ...amp, outputs: newOutputs, totalEnclosures };
              };

              // Remove from source, add to target
              const modifiedSource = modifyAmpOutput(sourceAmp, move.sourceChannelIndex, move.enclosureName, -1);
              const modifiedTarget = modifyAmpOutput(targetAmp, move.targetChannelIndex, move.enclosureName, 1);

              // Update locked amps - drag-drop only works between locked amps
              updateZone(activeZoneId, (zone) => {
                const newLocked = zone.lockedAmpInstances.map((a) => {
                  if (a.id === move.sourceAmpId) return modifiedSource;
                  if (a.id === move.targetAmpId) return modifiedTarget;
                  return a;
                });

                return { ...zone, lockedAmpInstances: newLocked };
              });
            }}
          />
        </section>
      </main>

      {/* Footer */}
      <footer className={`relative z-10 border-t border-gray-300 bg-white px-6 py-3 dark:border-neutral-800 ${matrixEnabled ? 'dark:bg-black/70' : 'dark:bg-neutral-900'}`}>
        {/* Matrix toggle - bottom left, dark mode only */}
        {darkMode && (
          <button
            onClick={() => setMatrixEnabled(!matrixEnabled)}
            className={`absolute bottom-1 left-1 text-lg font-mono leading-none transition-colors ${
              matrixEnabled
                ? "text-green-500 hover:text-green-400"
                : "text-neutral-600 hover:text-neutral-500"
            }`}
            title={matrixEnabled ? "Disable Matrix effect" : "Enable Matrix effect"}
          >
            ~
          </button>
        )}
        {/* Frequency Hemisphere - absolutely centered horizontally, top-aligned in footer */}
        <div className="absolute inset-0 flex items-start justify-center pointer-events-none">
          <FrequencyHemisphere
            frequency={getLowestFrequency(activeZone.requests.map((r) => r.enclosure.enclosure))}
          />
        </div>
        <div className="relative z-10 flex items-center justify-between">
          {/* Amplifier Toggles */}
          <div className="flex items-center gap-2 bg-white dark:bg-black/0">
            <span className="text-xs font-medium text-gray-600 dark:text-neutral-500">
              Amps{zones.length > 1 ? ` (${activeZone.name})` : ""}:
            </span>
            <div className="flex gap-1">
              {ampModels.map((model) => {
                const isDisabled = activeZone.disabledAmps.has(model);
                return (
                  <button
                    key={model}
                    onClick={() => toggleAmp(model)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      isDisabled
                        ? "bg-gray-200 text-gray-400 line-through dark:bg-neutral-800 dark:text-neutral-600"
                        : "text-white hover:brightness-110"
                    }`}
                    style={!isDisabled ? { backgroundColor: '#b59e5f', textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : undefined}
                    title={isDisabled ? `Enable ${model}` : `Disable ${model}`}
                  >
                    {model}
                  </button>
                );
              })}
            </div>
            <div className="mx-1 h-5 w-px bg-gray-300 dark:bg-neutral-700" />
            <button
              onClick={() => setRackMode(!rackMode)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                rackMode
                  ? "text-white hover:brightness-110"
                  : "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
              }`}
              style={rackMode ? { backgroundColor: '#b59e5f', textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : undefined}
              title={rackMode ? "Disable LA-RAK grouping" : "Enable LA-RAK rack grouping (LA12X only)"}
            >
              LA-RAK
            </button>
          </div>

          {/* Unit Toggle + Cable Gauge Selector + Bug Report */}
          <div className="flex items-center gap-4 bg-white dark:bg-black/0">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setUseFeet(true)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  useFeet
                    ? "text-white hover:brightness-110"
                    : "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                }`}
                style={useFeet ? { backgroundColor: '#b59e5f', textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : undefined}
              >
                ft
              </button>
              <button
                onClick={() => setUseFeet(false)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  !useFeet
                    ? "text-white hover:brightness-110"
                    : "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                }`}
                style={!useFeet ? { backgroundColor: '#b59e5f', textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : undefined}
              >
                m
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-600 dark:text-neutral-500">Cable Gauge:</span>
              <div className="flex gap-1">
                {CABLE_GAUGES.map((gauge) => (
                  <button
                    key={gauge.mm2}
                    onClick={() => setCableGaugeMm2(gauge.mm2)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      cableGaugeMm2 === gauge.mm2
                        ? "text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    }`}
                    style={cableGaugeMm2 === gauge.mm2 ? { backgroundColor: '#b59e5f', textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : undefined}
                    title={`${gauge.mm2}mm² / ${gauge.awg} AWG / ${gauge.swg} SWG`}
                  >
                    {gauge.mm2}mm²
                  </button>
                ))}
              </div>
            </div>
            <BugReportButton />
          </div>
        </div>
      </footer>
    </div>
  );
}
