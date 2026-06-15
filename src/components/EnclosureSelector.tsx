import React, { useState, useMemo, useEffect, useRef } from "react";
import type { Enclosure, EnclosureRequest, AmpConfig, EnclosureCompatibility, RiggingPartsData } from "../types";
import { getEnclosureCompatibility, getMinimumEnclosureCount } from "../solver/ampSolver";
import { getEnclosureImage } from "../utils/enclosureImages";

/** Info about locked enclosures per amplifier/rack */
export interface LockedAmpEnclosureInfo {
  ampLabel: string; // e.g., "LA-RAK #1" or "LA4X #2"
  ampId: string;
  enclosures: Map<string, number>; // enclosure name -> count
}

interface EnclosureSelectorProps {
  enclosures: Enclosure[];
  ampConfigs: AmpConfig[];
  requests: EnclosureRequest[];
  onRequestsChange: (requests: EnclosureRequest[]) => void;
  salesMode?: boolean;
  onBump?: () => void;
  /** Map of enclosure name -> count of locked enclosures */
  lockedEnclosureCounts?: Map<string, number>;
  /** Detailed locked enclosure info per amp/rack for grouping display */
  lockedAmpEnclosures?: LockedAmpEnclosureInfo[];
  /** Whether LA-RAK mode is active — shows ×N per ch control */
  rackMode?: boolean;
  /** Verified per-enclosure weights + rigging catalog (from data/rigging_parts.json) */
  riggingParts?: RiggingPartsData;
  /** Open the rigging manual PDF for the current rigging hardware */
  onShowRigging?: (url: string) => void;
  /** Show stack weight in lb (true) or kg (false) */
  weightInLbs?: boolean;
}

/** Fading "Minimum enclosure count" message */
function MinCountMessage({ show }: { show: boolean }) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (show) {
      setVisible(true);
      setFading(false);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setFading(true);
        timerRef.current = setTimeout(() => setVisible(false), 500);
      }, 2500);
    }
    return () => clearTimeout(timerRef.current);
  }, [show]);

  if (!visible) return null;

  return (
    <span
      className={`ml-2 inline-flex items-center gap-1 text-xs font-medium text-amber-500 transition-opacity duration-500 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      Minimum enclosure count
      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
      </svg>
    </span>
  );
}

export default function EnclosureSelector({
  enclosures,
  ampConfigs,
  requests,
  onRequestsChange,
  salesMode = false,
  onBump,
  lockedEnclosureCounts = new Map(),
  lockedAmpEnclosures = [],
  rackMode = false,
  riggingParts,
  onShowRigging,
  weightInLbs = true,
}: EnclosureSelectorProps) {
  const [selectedEnclosure, setSelectedEnclosure] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  // Track which request indices just got auto-bumped (for showing fade message)
  const [bumpedIndices, setBumpedIndices] = useState<Set<number>>(new Set());

  // Get compatibility info for all enclosures
  const compatibilityMap = useMemo(() => {
    const map = new Map<string, EnclosureCompatibility>();
    for (const enc of enclosures) {
      map.set(enc.enclosure, getEnclosureCompatibility(enc, ampConfigs));
    }
    return map;
  }, [enclosures, ampConfigs]);

  // Compute minimum counts for all enclosure types
  const minCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const enc of enclosures) {
      map.set(enc.enclosure, getMinimumEnclosureCount(enc, ampConfigs));
    }
    return map;
  }, [enclosures, ampConfigs]);

  // Get compatibility for selected enclosure
  const selectedCompatibility = selectedEnclosure
    ? compatibilityMap.get(selectedEnclosure)
    : null;

  // Hybrid enclosures (combined speaker systems)
  const hybridEnclosureNames = new Set([
    "Syva Low Syva",
  ]);

  // Subwoofer enclosures
  const subwooferEnclosureNames = new Set([
    "SB6i",
    "SB6r",
    "SB10i",
    "SB10r",
    "SB15m",
    "SB18m",
    "SB18 / SB18 IIi",
    "SB21",
    "SB28",
    "KS21",
    "KS21i",
    "KS28",
    "K1-SB",
    "Syva Low",
    "Syva Sub",
  ]);

  // LA4-only enclosures (Legacy category)
  const legacyEnclosureNames = new Set([
    "8XT",
    "12XT (Active)",
    "12XT (Passive)",
    "115XT HiQ",
    "112XT",
    "115XT",
    "MTD108a",
    "MTD112b",
    "MTD115b (Active)",
    "MTD115b (Passive)",
    "ARCS Wide/Focus",
    "ARCS",
    "Kiva",
    "Kilo",
    "SB118",
  ]);

  // Categorize enclosures
  const categorizedEnclosures = useMemo(() => {
    const hybrid: Enclosure[] = [];
    const current: Enclosure[] = [];
    const subwoofers: Enclosure[] = [];
    const legacy: Enclosure[] = [];

    for (const enc of enclosures) {
      if (hybridEnclosureNames.has(enc.enclosure)) {
        hybrid.push(enc);
      } else if (legacyEnclosureNames.has(enc.enclosure)) {
        legacy.push(enc);
      } else if (subwooferEnclosureNames.has(enc.enclosure)) {
        subwoofers.push(enc);
      } else {
        current.push(enc);
      }
    }

    return { hybrid, current, subwoofers, legacy };
  }, [enclosures]);

  // Per-array deployment limits (safe/max enclosure count) for an enclosure type in a given mode.
  // Falls back to the first deployment when no mode is set or the saved mode is unknown.
  const limitsFor = (encName: string, mode?: string): { safe: number | null; max: number | null } => {
    const deps = riggingParts?.enclosures?.[encName]?.deployments;
    if (!deps || deps.length === 0) return { safe: null, max: null };
    const m = mode && deps.some((d) => d.mode === mode) ? mode : deps[0].mode;
    const dep = deps.find((d) => d.mode === m);
    return { safe: dep?.safe ?? null, max: dep?.max ?? null };
  };

  // How many of each row's enclosures are already locked into amps (distributed across
  // rows of the same type, unlocked rows first). A clamp must never drop a row below its
  // share — those enclosures physically exist and are allocated to a locked amp.
  const rowLockedShares = (reqs: EnclosureRequest[]): number[] => {
    const remaining = new Map(lockedEnclosureCounts);
    const shares = new Array<number>(reqs.length).fill(0);
    const order = reqs
      .map((_, i) => i)
      .sort((a, b) => Number(Boolean(reqs[a].locked)) - Number(Boolean(reqs[b].locked)));
    for (const i of order) {
      const name = reqs[i].enclosure.enclosure;
      const rem = remaining.get(name) ?? 0;
      const sub = Math.min(rem, reqs[i].quantity);
      if (rem) remaining.set(name, rem - sub);
      shares[i] = sub;
    }
    return shares;
  };

  const handleAddEnclosure = () => {
    if (!selectedEnclosure) return;

    const enclosure = enclosures.find((e) => e.enclosure === selectedEnclosure);
    if (!enclosure) return;

    // Enforce minimum count
    const minCount = minCountMap.get(selectedEnclosure) ?? 1;
    const effectiveQuantity = Math.max(quantity, minCount);
    const wasBumped = effectiveQuantity > quantity;

    // Fill the first UNLOCKED row of this type that still has room (never a locked
    // row), then spill any overflow into new array row(s) — each capped at its
    // deployment's max — so a full array doesn't block adding more.
    const newRequests = [...requests];
    let remaining = effectiveQuantity;
    let flashIndex = -1;

    const fillIdx = newRequests.findIndex((r) => {
      if (r.enclosure.enclosure !== selectedEnclosure || r.locked) return false;
      const { max } = limitsFor(r.enclosure.enclosure, r.deploymentMode);
      return max == null || r.quantity < max;
    });
    if (fillIdx >= 0) {
      const target = newRequests[fillIdx];
      const { max } = limitsFor(target.enclosure.enclosure, target.deploymentMode);
      const room = max == null ? remaining : max - target.quantity;
      const add = Math.min(remaining, room);
      newRequests[fillIdx] = { ...target, quantity: target.quantity + add };
      remaining -= add;
    }

    // New arrays inherit the deployment of an existing array of this type (else default).
    const inheritMode =
      fillIdx >= 0
        ? newRequests[fillIdx].deploymentMode
        : newRequests.find((r) => r.enclosure.enclosure === selectedEnclosure)?.deploymentMode;
    const { max: newMax } = limitsFor(selectedEnclosure, inheritMode);
    while (remaining > 0) {
      const cap = newMax == null ? remaining : Math.min(remaining, newMax);
      if (flashIndex < 0) flashIndex = newRequests.length;
      newRequests.push({ id: crypto.randomUUID(), enclosure, quantity: Math.max(cap, minCount), deploymentMode: inheritMode });
      remaining -= cap;
      if (newMax == null) break;
    }

    onRequestsChange(newRequests);
    if (wasBumped && flashIndex >= 0) {
      setBumpedIndices(new Set([flashIndex]));
      onBump?.();
    }

    // Reset form
    setSelectedEnclosure("");
    setQuantity(1);
  };

  const handleRemoveRequest = (index: number) => {
    const newRequests = requests.filter((_, i) => i !== index);
    setBumpedIndices(new Set()); // indices shift on removal — clear stale bump flags
    onRequestsChange(newRequests);
  };

  const handleQuantityChange = (index: number, newQuantity: number) => {
    const req = requests[index];
    const encName = req.enclosure.enclosure;
    const minCount = minCountMap.get(encName) ?? 1;
    let effectiveQuantity = Math.max(newQuantity, minCount);
    const { max } = limitsFor(encName, req.deploymentMode);
    if (max != null) effectiveQuantity = Math.min(effectiveQuantity, max);
    // Never clamp below this row's amp-locked share (those enclosures physically exist)
    effectiveQuantity = Math.max(effectiveQuantity, rowLockedShares(requests)[index]);
    if (effectiveQuantity < 1) return;

    const wasBumped = newQuantity < minCount;

    const newRequests = [...requests];
    newRequests[index] = { ...newRequests[index], quantity: effectiveQuantity };
    onRequestsChange(newRequests);

    if (wasBumped) {
      setBumpedIndices(new Set([index]));
      onBump?.();
    }
  };

  const handlePerOutputChange = (index: number, value: number) => {
    const newReqs = [...requests];
    newReqs[index] = { ...newReqs[index], perOutput: value };
    onRequestsChange(newReqs);
  };

  const handleToggleLock = (index: number) => {
    const newReqs = [...requests];
    newReqs[index] = { ...newReqs[index], locked: !newReqs[index].locked };
    onRequestsChange(newReqs);
  };

  const handleDeploymentChange = (index: number, mode: string) => {
    const newReqs = [...requests];
    // Clear any rigging override so the new deployment's default rigging applies.
    const next = { ...newReqs[index], deploymentMode: mode, riggingCode: undefined };
    // Re-clamp the array down to the new deployment's max (e.g. flown 20 → stacked 9),
    // but never below this row's amp-locked share (those enclosures physically exist).
    const { max } = limitsFor(next.enclosure.enclosure, mode);
    if (max != null) next.quantity = Math.max(Math.min(next.quantity, max), rowLockedShares(requests)[index]);
    newReqs[index] = next;
    onRequestsChange(newReqs);
  };

  const handleRiggingCodeChange = (index: number, code: string) => {
    const newReqs = [...requests];
    newReqs[index] = { ...newReqs[index], riggingCode: code };
    onRequestsChange(newReqs);
  };

  return (
    <div className="space-y-6">
      {/* Add Enclosure Form */}
      <div className="rounded-lg border border-gray-300 bg-gray-200 p-4 dark:border-neutral-700 dark:bg-neutral-800">
        <h3 className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          Add Enclosures
        </h3>

        <div className="flex gap-3">
          <div className="flex-1">
            <select
              value={selectedEnclosure}
              onChange={(e) => setSelectedEnclosure(e.target.value)}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-gray-300"
            >
              <option value="">Select enclosure...</option>
              {categorizedEnclosures.hybrid.length > 0 && (
                <>
                  <option disabled>── Hybrid ──</option>
                  {categorizedEnclosures.hybrid.map((enc) => (
                    <option key={enc.enclosure} value={enc.enclosure}>
                      {enc.enclosure}
                    </option>
                  ))}
                </>
              )}
              {categorizedEnclosures.current.length > 0 && categorizedEnclosures.hybrid.length > 0 && (
                <option disabled>── Full Range ──</option>
              )}
              {categorizedEnclosures.current.map((enc) => (
                <option key={enc.enclosure} value={enc.enclosure}>
                  {enc.enclosure}
                </option>
              ))}
              {categorizedEnclosures.subwoofers.length > 0 && (
                <>
                  <option disabled>── Subwoofers ──</option>
                  {categorizedEnclosures.subwoofers.map((enc) => (
                    <option key={enc.enclosure} value={enc.enclosure}>
                      {enc.enclosure}
                    </option>
                  ))}
                </>
              )}
              {categorizedEnclosures.legacy.length > 0 && (
                <>
                  <option disabled>── Legacy ──</option>
                  {categorizedEnclosures.legacy.map((enc) => (
                    <option key={enc.enclosure} value={enc.enclosure}>
                      {enc.enclosure}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>

          <div className="w-24">
            <input
              type="number"
              min="1"
              max="100"
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-gray-300"
              placeholder="Qty"
            />
          </div>

          <button
            onClick={handleAddEnclosure}
            disabled={!selectedEnclosure}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
          >
            Add
          </button>
        </div>

        {/* Compatibility Info for Selected Enclosure (hidden in sales mode) */}
        {selectedCompatibility && !salesMode && (
          <div className="mt-3 rounded bg-white p-3 text-xs dark:bg-neutral-900">
            {selectedCompatibility.isLimitedCompatibility ? (
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-500">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span>
                  Limited compatibility: Only works with{" "}
                  <strong>
                    {selectedCompatibility.autoSelectedAmp?.model}
                    {selectedCompatibility.autoSelectedAmp?.mode &&
                      ` (${selectedCompatibility.autoSelectedAmp.mode})`}
                  </strong>
                </span>
              </div>
            ) : (
              <div className="text-gray-600 dark:text-neutral-400">
                <span className="font-medium">Compatible amplifiers: </span>
                {selectedCompatibility.compatibleAmpConfigs
                  .map((c) => c.model + (c.mode ? ` (${c.mode})` : ""))
                  .join(", ")}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Locked Enclosures - Grouped by Amplifier */}
      {lockedAmpEnclosures.length > 0 && (
        <div className="space-y-3">
          {lockedAmpEnclosures.map((ampInfo) => {
            // Get all enclosures for this amp
            const enclosureEntries = Array.from(ampInfo.enclosures.entries()).filter(([, count]) => count > 0);
            if (enclosureEntries.length === 0) return null;

            const isDark = document.documentElement.classList.contains('dark');
            const goldColor = isDark ? '#b59e5f' : '#7A6B3A';
            const goldColorLight = isDark ? '#b59e5f33' : '#b59e5f22';

            return (
              <div
                key={ampInfo.ampId}
                className="rounded-lg border overflow-hidden"
                style={{ borderColor: goldColor, backgroundColor: goldColorLight }}
              >
                {/* Amp label header */}
                <div className="flex items-center gap-2 px-3 py-1.5 border-b" style={{ borderColor: goldColor }}>
                  <svg className="h-4 w-4" fill={goldColor} viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                  </svg>
                  <span className="font-medium text-gray-800 dark:text-white text-sm">
                    {ampInfo.ampLabel}
                  </span>
                </div>

                {/* Enclosures list */}
                <div className="divide-y" style={{ borderColor: `${goldColor}66` }}>
                  {enclosureEntries.map(([encName, count]) => {
                    const enclosure = enclosures.find(e => e.enclosure === encName);
                    const imageUrl = getEnclosureImage(encName, count);

                    return (
                      <div
                        key={encName}
                        className="flex items-center gap-3 py-0.5 px-3"
                      >
                        {/* Enclosure Image */}
                        {imageUrl && (
                          <div className="h-[50px] w-[80px] flex-shrink-0 overflow-hidden rounded opacity-60">
                            <img
                              src={imageUrl}
                              alt={encName}
                              className="h-full w-full object-contain"
                            />
                          </div>
                        )}
                        <div className="flex-1 opacity-80">
                          <span className="font-medium" style={{ color: goldColor }}>
                            {encName}
                          </span>
                          {!salesMode && enclosure && (
                            <div className="text-xs" style={{ color: goldColor, opacity: 0.7 }}>
                              {enclosure.nominal_impedance_ohms}Ω
                            </div>
                          )}
                        </div>
                        {/* ×N per ch badge (if perOutput > 1) */}
                        {(() => {
                          const req = requests.find(r => r.enclosure.enclosure === encName);
                          const perOut = req?.perOutput ?? enclosure?.preferredPerOutput ?? 1;
                          if (perOut <= 1) return null;
                          return (
                            <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: goldColor, opacity: 0.7 }}>
                              ×{perOut} per ch
                            </span>
                          );
                        })()}
                        {/* Locked count */}
                        <span
                          className="w-16 rounded border px-2 py-1 text-center text-sm font-medium"
                          style={{ borderColor: goldColor, backgroundColor: goldColorLight, color: goldColor }}
                        >
                          {count}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Unlocked Enclosures */}
      {requests.length > 0 && (() => {
        // Distribute amp-locked counts across rows of the same enclosure type, draining
        // UNLOCKED rows first so a pinned (locked) row isn't hidden while an unlocked
        // row of the same type remains. Supports multiple arrays of one type.
        const lockedShares = rowLockedShares(requests);
        const rowUnlockedCounts = requests.map((req, i) => req.quantity - lockedShares[i]);
        // Number multiple arrays of the same enclosure type (Array 1, Array 2, …),
        // counting only rows that will actually render (a fully amp-locked row is hidden).
        const typeTotals = new Map<string, number>();
        requests.forEach((r, i) => {
          if (rowUnlockedCounts[i] > 0) {
            typeTotals.set(r.enclosure.enclosure, (typeTotals.get(r.enclosure.enclosure) ?? 0) + 1);
          }
        });
        const typeSeen = new Map<string, number>();
        const rowArrayNums = requests.map((r, i) => {
          if (rowUnlockedCounts[i] <= 0) return 0; // hidden row — not rendered
          const n = (typeSeen.get(r.enclosure.enclosure) ?? 0) + 1;
          typeSeen.set(r.enclosure.enclosure, n);
          return n;
        });
        return (
        <div className="space-y-2">
          {requests.map((request, index) => {
            const compat = compatibilityMap.get(request.enclosure.enclosure);
            const minCount = minCountMap.get(request.enclosure.enclosure) ?? 1;
            const showBumpMessage = bumpedIndices.has(index);
            const imageUrl = getEnclosureImage(request.enclosure.enclosure, request.quantity);
            const unlockedCount = rowUnlockedCounts[index];
            const lockedCount = request.quantity - unlockedCount;

            // Skip if all are locked (they're shown in the locked section above)
            if (unlockedCount <= 0) return null;

            // Per-row deployment + the rigging piece it implies (drives this array's weight).
            // Fall back to the first deployment if the saved mode is stale/unknown.
            const encRigRow = riggingParts?.enclosures?.[request.enclosure.enclosure];
            const rowDeployMode =
              request.deploymentMode && encRigRow?.deployments?.some((d) => d.mode === request.deploymentMode)
                ? request.deploymentMode
                : encRigRow?.deployments?.[0]?.mode;
            const rowDeploy = encRigRow?.deployments?.find((d) => d.mode === rowDeployMode);
            const rowRiggingCode = rowDeploy?.default_rigging ?? encRigRow?.recommended_rigging;
            // The rigging piece actually used: a per-row override, else the deployment default,
            // validated against the parts list so the <select> value always matches an option.
            const riggingPartsList = encRigRow?.rigging_parts ?? [];
            const riggingCodeExists = (c?: string) => !!c && riggingPartsList.some((p) => p.code === c);
            const selectedRiggingCode = riggingCodeExists(request.riggingCode)
              ? request.riggingCode
              : riggingCodeExists(rowRiggingCode)
                ? rowRiggingCode
                : riggingPartsList[0]?.code;

            // Per-array limits for the current deployment (hard cap at max; amber warning past safe)
            const rowMax = rowDeploy?.max ?? null;
            const rowSafe = rowDeploy?.safe ?? null;
            const atMax = rowMax != null && request.quantity >= rowMax;
            const overSafe = rowSafe != null && request.quantity > rowSafe && (rowMax == null || request.quantity <= rowMax);
            const deployWord = rowDeployMode === "ground_stack" ? "stacked" : rowDeployMode === "surface_mount" ? "mounted" : "flown";

            // "Array N" label when this enclosure type has more than one row
            const arrayNum = rowArrayNums[index];
            const showArrayLabel = (typeTotals.get(request.enclosure.enclosure) ?? 0) > 1;

            // ×N per-channel control — only for enclosures with per_output > 1 on an enabled amp
            const perChannelControl = (() => {
              let maxPerOutput = 1;
              for (const key of Object.keys(request.enclosure.max_enclosures)) {
                const lim = request.enclosure.max_enclosures[key];
                if (lim && lim.per_output > maxPerOutput) maxPerOutput = lim.per_output;
              }
              const minPerOutput = request.enclosure.preferredPerOutput ?? 1;
              const currentPerOutput = request.perOutput ?? minPerOutput;
              if (maxPerOutput <= 1) return null;
              return (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handlePerOutputChange(index, Math.max(minPerOutput, currentPerOutput - 1))}
                    disabled={currentPerOutput <= minPerOutput || request.locked}
                    className="h-6 w-6 rounded border border-gray-300 bg-gray-100 text-xs text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                  >
                    -
                  </button>
                  <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    ×{currentPerOutput} per ch
                  </span>
                  <button
                    onClick={() => handlePerOutputChange(index, Math.min(maxPerOutput, currentPerOutput + 1))}
                    disabled={currentPerOutput >= maxPerOutput || request.locked}
                    className="h-6 w-6 rounded border border-gray-300 bg-gray-100 text-xs text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                  >
                    +
                  </button>
                </div>
              );
            })();

            // Deployment + rigging dropdowns + Show-rigging link — per row.
            // The rigging select renders whenever rigging parts exist, even with no deployments.
            const deploymentControl = (() => {
              const deps = encRigRow?.deployments ?? [];
              const hasDeps = deps.length > 0;
              const hasParts = riggingPartsList.length > 0;
              if (!hasDeps && !hasParts && !encRigRow?.rigging_pdf) return null;
              return (
                <div className="flex items-center gap-1.5 text-[10px]">
                  {hasDeps && (
                  <select
                    value={rowDeployMode}
                    onChange={(e) => handleDeploymentChange(index, e.target.value)}
                    disabled={request.locked}
                    title="Deployment — changes the default rigging hardware"
                    className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] text-gray-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-300 focus:outline-none"
                  >
                    {deps.map((d) => (
                      <option key={d.mode} value={d.mode}>{d.label}</option>
                    ))}
                  </select>
                  )}
                  {hasParts && (
                    <select
                      value={selectedRiggingCode ?? ""}
                      onChange={(e) => handleRiggingCodeChange(index, e.target.value)}
                      disabled={request.locked}
                      title="Rigging hardware for this array"
                      className="max-w-[12rem] rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] text-gray-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-300 focus:outline-none"
                    >
                      {riggingPartsList.map((p) => (
                        <option key={p.code} value={p.code}>
                          {p.code}{p.weight_kg != null ? ` (${p.weight_kg} kg)` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {encRigRow?.rigging_pdf && (
                    <button
                      type="button"
                      onClick={() => onShowRigging?.(encRigRow.rigging_pdf!)}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                      title="Open the rigging manual PDF for the current rigging hardware"
                    >
                      Show rigging
                    </button>
                  )}
                </div>
              );
            })();

            // Stack weight — shown on the bottom line, left of the deployment dropdown
            const weightControl = (() => {
              const encW = encRigRow?.weight_kg;
              if (typeof encW !== "number") return null;
              const selPart = selectedRiggingCode ? encRigRow?.rigging_parts.find((p) => p.code === selectedRiggingCode) : undefined;
              const rigKg = selPart?.weight_kg ?? 0;
              const stackKg = encW * request.quantity + rigKg;
              const stackValue = weightInLbs ? Math.round(stackKg * 2.20462) : Math.round(stackKg);
              const unit = weightInLbs ? "lb" : "kg";
              const title = `${request.quantity} × ${encW} kg${rigKg ? ` + ${selPart?.code} ${rigKg} kg` : ""} = ${Math.round(stackKg)} kg / ${Math.round(stackKg * 2.20462)} lb`;
              return (
                <div className="flex-shrink-0 leading-tight" title={title}>
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{stackValue}</span>
                  <span className="text-[10px] font-normal text-gray-400 dark:text-neutral-500"> {unit}</span>
                </div>
              );
            })();

            const hasBottomRow = Boolean(weightControl || deploymentControl);

            const isLocked = Boolean(request.locked);
            const lockGold = document.documentElement.classList.contains("dark") ? "#b59e5f" : "#7A6B3A";

            return (
              <div
                key={request.id}
                className={`relative flex items-center gap-3 rounded-lg border py-1 px-3 bg-gray-100 dark:bg-neutral-800 ${isLocked ? "" : "border-gray-300 dark:border-neutral-700"}`}
                style={isLocked ? { borderColor: lockGold } : undefined}
              >
                {/* Enclosure Image — spans the row height; grows taller when a second control line is present */}
                {imageUrl && (
                  <div className={`w-[88px] flex-shrink-0 overflow-hidden rounded ${hasBottomRow && request.quantity > 1 ? "h-[72px]" : "h-[50px]"}`}>
                    <img
                      src={imageUrl}
                      alt={request.enclosure.enclosure}
                      className="h-full w-full object-contain"
                    />
                  </div>
                )}
                {/* Right column: stacked control lines */}
                <div className="flex-1">
                {/* Top line: name, quantity, lock, remove */}
                <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex items-center">
                    <span className="font-medium text-gray-900 dark:text-gray-200 whitespace-nowrap">
                      {request.enclosure.enclosure}
                    </span>
                    <MinCountMessage
                      show={showBumpMessage}
                      key={showBumpMessage ? Date.now() : "stable"}
                    />
                  </div>
                  {(showArrayLabel || !salesMode) && (
                    <div className="text-xs text-gray-500 dark:text-neutral-500">
                      {showArrayLabel && (
                        <span className="font-semibold text-gray-600 dark:text-neutral-300 whitespace-nowrap">Array {arrayNum}</span>
                      )}
                      {showArrayLabel && !salesMode && <span className="mx-1">·</span>}
                      {!salesMode && (
                        <>
                          {request.enclosure.nominal_impedance_ohms}Ω
                          {compat?.isLimitedCompatibility && (
                            <span className="ml-2">({compat.autoSelectedAmp?.model} only)</span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Quantity count, with the ×N per-channel control stacked beneath it */}
                <div className="flex flex-col items-end gap-1.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      handleQuantityChange(index, request.quantity - 1)
                    }
                    disabled={isLocked || unlockedCount <= Math.max(minCount - lockedCount, 1)}
                    className="h-8 w-8 rounded border border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={unlockedCount}
                    disabled={isLocked}
                    onChange={(e) => {
                      const newUnlocked = parseInt(e.target.value) || 1;
                      handleQuantityChange(index, lockedCount + newUnlocked);
                    }}
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-center text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900 dark:text-gray-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    onClick={() =>
                      handleQuantityChange(index, request.quantity + 1)
                    }
                    disabled={isLocked || atMax}
                    title={atMax ? `Max ${rowMax} ${deployWord} for ${request.enclosure.enclosure}` : undefined}
                    className="h-8 w-8 rounded border border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                  >
                    +
                  </button>
                </div>
                {perChannelControl}
                </div>

                {/* Lock this row "as is" — freezes its controls; still solved normally */}
                <button
                  onClick={() => handleToggleLock(index)}
                  className="rounded p-1 transition-colors hover:bg-gray-200 dark:hover:bg-neutral-700"
                  style={isLocked ? { backgroundColor: `${lockGold}33`, color: lockGold } : undefined}
                  title={isLocked ? "Unlock this enclosure row" : "Lock this enclosure row so it can't be changed"}
                >
                  {isLocked ? (
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="h-5 w-5 text-gray-400 dark:text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>

                <button
                  onClick={() => handleRemoveRequest(index)}
                  disabled={lockedCount > 0 || isLocked}
                  className={`rounded p-1 ${
                    lockedCount > 0 || isLocked
                      ? "cursor-not-allowed text-gray-300 dark:text-neutral-600"
                      : "text-gray-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/50 dark:hover:text-red-500"
                  }`}
                  title={isLocked ? "Unlock to remove" : lockedCount > 0 ? "Cannot remove - has locked enclosures" : "Remove"}
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
                </div>

                {/* Secondary controls on their own line to avoid crowding the row */}
                {hasBottomRow && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    {weightControl}
                    {deploymentControl}
                  </div>
                )}
                {overSafe && (
                  <div className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-500 whitespace-nowrap" title={`L-Acoustics safe ${deployWord} limit is ${rowSafe}${rowMax != null ? `; absolute max ${rowMax}` : ""}`}>
                    ⚠ over safe {deployWord} limit ({rowSafe})
                  </div>
                )}
                </div>
              </div>
            );
          })}
        </div>
        );
      })()}

      {requests.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-neutral-700 dark:text-neutral-500">
          <p>No enclosures added yet.</p>
          <p className="mt-1 text-sm">
            Select an enclosure and quantity above to begin.
          </p>
        </div>
      )}
    </div>
  );
}
