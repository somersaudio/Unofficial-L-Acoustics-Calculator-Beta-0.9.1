import React, { useState, useMemo, useEffect, useRef } from "react";
import type { Enclosure, EnclosureRequest, AmpConfig, EnclosureCompatibility } from "../types";
import { getEnclosureCompatibility, getMinimumEnclosureCount } from "../solver/ampSolver";

interface EnclosureSelectorProps {
  enclosures: Enclosure[];
  ampConfigs: AmpConfig[];
  requests: EnclosureRequest[];
  onRequestsChange: (requests: EnclosureRequest[]) => void;
  salesMode?: boolean;
  onBump?: () => void;
}

/** Fading "Minimum enclosure count" message */
function MinCountMessage({ show }: { show: boolean }) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

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
    const current: Enclosure[] = [];
    const legacy: Enclosure[] = [];

    for (const enc of enclosures) {
      if (legacyEnclosureNames.has(enc.enclosure)) {
        legacy.push(enc);
      } else {
        current.push(enc);
      }
    }

    return { current, legacy };
  }, [enclosures]);

  const handleAddEnclosure = () => {
    if (!selectedEnclosure) return;

    const enclosure = enclosures.find((e) => e.enclosure === selectedEnclosure);
    if (!enclosure) return;

    // Enforce minimum count
    const minCount = minCountMap.get(selectedEnclosure) ?? 1;
    const effectiveQuantity = Math.max(quantity, minCount);
    const wasBumped = effectiveQuantity > quantity;

    // Check if this enclosure type already exists in requests
    const existingIndex = requests.findIndex(
      (r) => r.enclosure.enclosure === selectedEnclosure
    );

    if (existingIndex >= 0) {
      const newRequests = [...requests];
      newRequests[existingIndex] = {
        ...newRequests[existingIndex],
        quantity: newRequests[existingIndex].quantity + effectiveQuantity,
      };
      onRequestsChange(newRequests);
    } else {
      onRequestsChange([...requests, { enclosure, quantity: effectiveQuantity }]);
      if (wasBumped) {
        // The new request will be at the end
        setBumpedIndices(new Set([requests.length]));
        onBump?.();
      }
    }

    // Reset form
    setSelectedEnclosure("");
    setQuantity(1);
  };

  const handleRemoveRequest = (index: number) => {
    const newRequests = requests.filter((_, i) => i !== index);
    onRequestsChange(newRequests);
  };

  const handleQuantityChange = (index: number, newQuantity: number) => {
    const encName = requests[index].enclosure.enclosure;
    const minCount = minCountMap.get(encName) ?? 1;
    const effectiveQuantity = Math.max(newQuantity, minCount);
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

  return (
    <div className="space-y-6">
      {/* Add Enclosure Form */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-neutral-700 dark:bg-neutral-800">
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
              {categorizedEnclosures.current.map((enc) => (
                <option key={enc.enclosure} value={enc.enclosure}>
                  {enc.enclosure}
                </option>
              ))}
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

      {/* Current Requests List */}
      {requests.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Enclosures to Power
          </h3>

          <div className="space-y-2">
            {requests.map((request, index) => {
              const compat = compatibilityMap.get(request.enclosure.enclosure);
              const minCount = minCountMap.get(request.enclosure.enclosure) ?? 1;
              const showBumpMessage = bumpedIndices.has(index);
              return (
                <div
                  key={`${request.enclosure.enclosure}-${index}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800"
                >
                  <div className="flex-1">
                    <div className="flex items-center">
                      <span className="font-medium text-gray-900 dark:text-gray-200">
                        {request.enclosure.enclosure}
                      </span>
                      <MinCountMessage
                        show={showBumpMessage}
                        key={showBumpMessage ? Date.now() : "stable"}
                      />
                    </div>
                    {!salesMode && (
                      <div className="text-xs text-gray-500 dark:text-neutral-500">
                        {request.enclosure.nominal_impedance_ohms}Ω
                        {!request.enclosure.parallelAllowed && (
                          <span className="ml-2 text-amber-600 dark:text-amber-500">
                            (No parallel)
                          </span>
                        )}
                        {compat?.isLimitedCompatibility && (
                          <span className="ml-2 text-blue-600 dark:text-blue-400">
                            ({compat.autoSelectedAmp?.model} only)
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        handleQuantityChange(index, request.quantity - 1)
                      }
                      disabled={request.quantity <= minCount}
                      className="h-8 w-8 rounded border border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={minCount}
                      value={request.quantity}
                      onChange={(e) =>
                        handleQuantityChange(
                          index,
                          parseInt(e.target.value) || minCount
                        )
                      }
                      className="w-16 rounded border border-gray-300 px-2 py-1 text-center text-sm dark:border-neutral-600 dark:bg-neutral-900 dark:text-gray-300"
                    />
                    <button
                      onClick={() =>
                        handleQuantityChange(index, request.quantity + 1)
                      }
                      className="h-8 w-8 rounded border border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-600"
                    >
                      +
                    </button>
                  </div>

                  <button
                    onClick={() => handleRemoveRequest(index)}
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/50 dark:hover:text-red-500"
                    title="Remove"
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
              );
            })}
          </div>

        </div>
      )}

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
