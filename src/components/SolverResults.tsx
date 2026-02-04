import React, { useState, useMemo, useEffect, useRef } from "react"; // eslint-disable-line
import type { AmpInstance, OutputAllocation, ZoneWithSolution, SolverSolution } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS, getMaxCableLength } from "../types";
import { getImpedanceErrors, repackAmpInstance, spreadAmpInstance } from "../solver/ampSolver";
import { getEnclosureImage } from "../utils/enclosureImages";

interface SolverResultsProps {
  zoneSolutions: ZoneWithSolution[];
  activeZoneId: string;
  salesMode?: boolean;
  cableGaugeMm2?: number;
  useFeet?: boolean;
  onAdjustEnclosure?: (enclosureName: string, delta: number) => void;
  onLockAmpInstance?: (ampInstance: AmpInstance) => void;
  onUnlockAmpInstance?: (ampInstanceId: string) => void;
}

/** Returns inline style for teal output label color that darkens as output index increases */
function getOutputTealStyle(outputIndex: number, totalOutputs: number): React.CSSProperties {
  const t = totalOutputs <= 1 ? 0 : outputIndex / (totalOutputs - 1);
  const isDark = document.documentElement.classList.contains("dark");
  // Teal hue ~180, Light mode: 45% (lightest, Output 1) → 25% (darkest, Output 4)
  // Dark mode: 65% (lightest) → 45% (darkest)
  const lightness = isDark ? 65 - t * 20 : 45 - t * 20;
  return { color: `hsl(180, 60%, ${lightness}%)` };
}

/** Returns inline style for purple channel color that darkens as channel index increases */
function getChannelPurpleStyle(channelIndex: number, totalChannels: number): React.CSSProperties {
  const t = totalChannels <= 1 ? 0 : channelIndex / (totalChannels - 1);
  const isDark = document.documentElement.classList.contains("dark");
  // Light mode: 60% (lightest, Ch 1) → 30% (darkest, Ch 16)
  // Dark mode: 80% (lightest) → 55% (darkest)
  const lightness = isDark ? 80 - t * 25 : 60 - t * 30;
  return { color: `hsl(270, 70%, ${lightness}%)` };
}

/** Returns inline style for gold signal type color - starts dark and gets lighter within a multi-channel group */
function getSignalTypeGoldStyle(indexInGroup: number, totalInGroup: number): React.CSSProperties {
  const t = totalInGroup <= 1 ? 0 : indexInGroup / (totalInGroup - 1);
  const isDark = document.documentElement.classList.contains("dark");
  // Gold hue ~45, high saturation
  // Light mode: 35% (darkest, first) → 55% (lightest, last)
  // Dark mode: 45% (darkest) → 65% (lightest)
  const lightness = isDark ? 45 + t * 20 : 35 + t * 20;
  return { color: `hsl(45, 80%, ${lightness}%)` };
}

function getLoadColor(loadPercent: number): string {
  if (loadPercent > 100) return "text-red-600 dark:text-red-500";
  if (loadPercent > 80) return "text-amber-600 dark:text-amber-500";
  return "text-green-600 dark:text-green-500";
}

/** Input letters for routing (A, B, C, D for 4-channel, extends for 16-channel) */
const INPUT_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

/**
 * Get input routing letter for a channel based on which signal group it belongs to.
 * For 4-channel amps: ABCD (4 separate), AABB (2 groups), AAAA (1 group), etc.
 * Groups are determined by multi-channel enclosures sharing the same input.
 */
function getInputLetter(outputs: OutputAllocation[], channelIndex: number): string {
  // Find which signal group this channel belongs to
  let groupIndex = 0;
  let currentGroup = -1;

  for (let i = 0; i <= channelIndex && i < outputs.length; i++) {
    const output = outputs[i];
    const hasLoad = output.totalEnclosures > 0;

    if (!hasLoad) {
      // Empty channel - continues previous group or starts new one
      if (i === channelIndex) return INPUT_LETTERS[groupIndex] || "?";
      continue;
    }

    // Check if this is a primary channel (first in a multi-channel group)
    const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
    const channelsPerUnit = output.enclosures[0]?.enclosure.signal_channels.length ?? 1;
    const isPrimary = !isMultiChannel || (output.outputIndex % channelsPerUnit) === 0;

    if (isPrimary && i > 0) {
      // Check if this starts a new group (different enclosure type or new primary)
      const prevOutput = outputs[i - 1];
      const prevEnclosure = prevOutput.enclosures[0]?.enclosure.enclosure;
      const currEnclosure = output.enclosures[0]?.enclosure.enclosure;

      if (prevEnclosure !== currEnclosure || isPrimary) {
        groupIndex++;
      }
    }

    currentGroup = groupIndex;
  }

  return INPUT_LETTERS[currentGroup] || "?";
}

/**
 * Build input routing pattern for display (e.g., "AABB", "ABCD")
 */
function getInputRoutingPattern(outputs: OutputAllocation[]): string {
  return outputs.map((_, i) => getInputLetter(outputs, i)).join("");
}

const MAX_ENCLOSURE_TYPES_PER_AMP = 3;

/** Input routing options for each output channel */
const ROUTING_OPTIONS = [
  "A", "B", "A + B", "A - B",
  "C", "D", "C + D", "C - D",
  "A + B + C + D"
] as const;
type RoutingOption = typeof ROUTING_OPTIONS[number];

/** Background colors for enclosure types (faint saturation) */
const ENCLOSURE_TYPE_COLORS = [
  "rgba(189, 199, 124, 0.15)", // 1st type: #bdc77c - gold/olive
  "rgba(132, 190, 197, 0.15)", // 2nd type: #84bec5 - teal
  "rgba(222, 170, 66, 0.15)",  // 3rd type: #deaa42 - amber
];

const ENCLOSURE_TYPE_COLORS_DARK = [
  "rgba(189, 199, 124, 0.12)", // 1st type: #bdc77c - gold/olive
  "rgba(132, 190, 197, 0.12)", // 2nd type: #84bec5 - teal
  "rgba(222, 170, 66, 0.12)",  // 3rd type: #deaa42 - amber
];

/** Build a map of enclosure name -> type index (0, 1, 2) for coloring
 * Color is determined by which 4-channel group the enclosure FIRST appears in:
 * - Channels 1-4 (index 0-3) → Color 0 (gold/olive)
 * - Channels 5-8 (index 4-7) → Color 1 (teal)
 * - Channels 9-12 (index 8-11) → Color 2 (amber)
 * All subsequent appearances of the same enclosure type get the same color.
 */
function buildEnclosureTypeMap(instance: AmpInstance): Map<string, number> {
  const typeMap = new Map<string, number>();
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      const name = entry.enclosure.enclosure;
      if (!typeMap.has(name)) {
        // Color based on 4-channel group where this enclosure first appears
        const channelGroup = Math.floor(output.outputIndex / 4);
        // Cap at max color index (0, 1, or 2)
        const colorIndex = Math.min(channelGroup, MAX_ENCLOSURE_TYPES_PER_AMP - 1);
        typeMap.set(name, colorIndex);
      }
    }
  }
  return typeMap;
}

/** Get background color for an enclosure type */
function getEnclosureTypeBackground(enclosureName: string, typeMap: Map<string, number>): string | undefined {
  const typeIndex = typeMap.get(enclosureName);
  if (typeIndex === undefined) return undefined;
  const isDark = document.documentElement.classList.contains("dark");
  return isDark ? ENCLOSURE_TYPE_COLORS_DARK[typeIndex] : ENCLOSURE_TYPE_COLORS[typeIndex];
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

/** Routing selector dropdown for input-to-output configuration */
function RoutingSelector({ value, onChange }: { value: RoutingOption; onChange: (value: RoutingOption) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-200 hover:text-gray-800 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600 transition-colors"
        title="Input routing configuration"
      >
        {value}
      </button>
      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 z-50 rounded border border-gray-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800 min-w-[90px]">
          {ROUTING_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => {
                onChange(option);
                setIsOpen(false);
              }}
              className={`block w-full px-2 py-1 text-left text-[10px] hover:bg-gray-100 dark:hover:bg-neutral-700 ${
                option === value
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                  : "text-gray-700 dark:text-neutral-300"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact cable length display for a given impedance and selected gauge */
function CableLengthInfo({ impedanceOhms, gaugeMm2, useFeet }: { impedanceOhms: number; gaugeMm2: number; useFeet: boolean }) {
  if (impedanceOhms === Infinity || impedanceOhms <= 0) return null;

  const limit = getMaxCableLength(impedanceOhms, gaugeMm2);
  if (!limit || limit.meters === null) return null;

  const lengthDisplay = useFeet ? `${limit.feet}ft` : `${limit.meters}m`;

  if (limit.estimated) {
    return (
      <div className="text-[10px] text-gray-500 dark:text-neutral-500">
        <span><span style={{ color: "#D4A017" }}>Estimated</span> max cable: <span className="font-medium text-gray-700 dark:text-neutral-300">{lengthDisplay}</span></span>
      </div>
    );
  }

  return (
    <div className="text-[10px] text-gray-500 dark:text-neutral-500">
      <span>Max cable: <span className="font-medium text-gray-700 dark:text-neutral-300">{lengthDisplay}</span></span>
    </div>
  );
}

function OutputCard({ output, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, isSecondaryChannel = false, hideEnclosureName = false, enclosureTypeMap, inputLetter, routing, onRoutingChange }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; isSecondaryChannel?: boolean; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetter?: string; routing?: RoutingOption; onRoutingChange?: (value: RoutingOption) => void }) {
  const hasLoad = output.totalEnclosures > 0;
  const outputLabel = ampOutputCount === 16
    ? `Ch ${output.outputIndex + 1}`
    : `Output ${output.outputIndex + 1}`;
  const minAllowed = output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
  const hasImpedanceError = !salesMode && output.impedanceOhms < minAllowed && output.impedanceOhms !== Infinity;

  const is16Channel = ampOutputCount === 16;

  // Get enclosure type background for the entire card (based on first enclosure)
  const cardTypeBg = hasLoad && enclosureTypeMap && output.enclosures[0]
    ? getEnclosureTypeBackground(output.enclosures[0].enclosure.enclosure, enclosureTypeMap)
    : undefined;


  // Secondary channel: shaded appearance, show grayed-out enclosure name and signal type
  // Match primary card structure for vertical alignment
  if (isSecondaryChannel && hasLoad) {
    return (
      <div
        className={`flex flex-col rounded border p-2 text-xs min-w-0 ${
          hasImpedanceError
            ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
            : "border-blue-200/60 dark:border-neutral-700"
        }`}
        style={!hasImpedanceError ? {
          backgroundColor: cardTypeBg || undefined,
          backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)'
        } : undefined}
      >
        {/* Invisible header spacer to match primary card's "Output N NL4" header height */}
        {!is16Channel && (
          <div className="mb-1 font-medium invisible" aria-hidden="true">X</div>
        )}
        {!salesMode ? (
          <div className="flex-1 flex flex-col">
            {/* Channel header */}
            <div className={`font-medium truncate`} style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
              Ch {output.outputIndex + 1}
            </div>

            {/* Separator line for 16-channel uniformity */}
            {is16Channel && (
              <div className={`border-t my-1 ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />
            )}

            <div className="flex-1">
              {/* Show grayed-out enclosure name and signal type */}
              {output.enclosures.map((entry, i) => {
                const posInGroup = output.outputIndex % entry.enclosure.signal_channels.length;
                const totalInGroup = entry.enclosure.signal_channels.length;
                return (
                  <div key={i}>
                    {!is16Channel && (
                      <div className="text-sm text-gray-400 dark:text-neutral-600">
                        {entry.count}x {entry.enclosure.enclosure}
                      </div>
                    )}
                    <div
                      className="text-[10px] font-medium"
                      style={getSignalTypeGoldStyle(posInGroup, totalInGroup)}
                    >
                      {entry.enclosure.signal_channels[posInGroup]}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Bottom row: impedance */}
            <div className="flex items-center justify-end pt-0.5">
              <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col rounded border p-2 text-xs min-w-0 ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
      style={cardTypeBg && !hasImpedanceError ? { backgroundColor: cardTypeBg } : undefined}
    >
      <div
        className={`${is16Channel ? "truncate" : "mb-1"} font-medium`}
        style={is16Channel ? getChannelPurpleStyle(output.outputIndex, ampOutputCount) : getOutputTealStyle(output.outputIndex, ampOutputCount)}
      >
        {outputLabel}
        {is16Channel && hasImpedanceError && (
          <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
        )}
        {!is16Channel && (
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
        )}
      </div>
      {/* Separator line - explicitly shown for 16-channel below Ch header */}
      {is16Channel && hasLoad && (
        <div className={`border-t my-1 ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />
      )}
      {hasLoad ? (
        <>
          {!salesMode && (
            <div className={`flex-1 flex flex-col ${!is16Channel ? "border-t" : ""} ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
              {/* Only show "Ch N" label for non-16-channel amps (16ch already shows it as outputLabel above) */}
              {!is16Channel && (
                <div className="pt-1 font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                  Ch {output.outputIndex + 1}
                  {hasImpedanceError && (
                    <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                  )}
                </div>
              )}
              <div className="flex-1">
                {(() => {
                  const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                  const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
                  const impedanceAboveRated = !isMultiChannel && output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                  return output.enclosures.map((entry, i) => (
                    <div key={i}>
                      {/* Hide enclosure name when shown as header above (L2/L2D on 16ch) */}
                      {!hideEnclosureName && (
                        <div className="flex items-center gap-1 text-sm text-gray-900 dark:text-gray-200">
                          {entry.count}x {entry.enclosure.enclosure}
                          {impedanceAboveRated && (
                            <>
                              <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                              </svg>
                              {onAdjustEnclosure && (
                                <button
                                  onClick={() => onAdjustEnclosure(entry.enclosure.enclosure, 1)}
                                  className="ml-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:hover:bg-amber-900/60"
                                  title="Add 1 more for recommended load"
                                >
                                  + 1
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {/* Signal type - always shown for uniform display */}
                      <div
                        className="text-[10px] font-medium"
                        style={getSignalTypeGoldStyle(0, 1)}
                      >
                        {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                      </div>
                    </div>
                  ));
                })()}
              </div>
              {/* Bottom row: routing selector at left, cable length in middle (non-16ch), impedance at right */}
              {!is16Channel && (
                <div className="flex items-end justify-between pt-0.5 text-[10px]">
                  <div className="flex items-center gap-1">
                    {onRoutingChange && (
                      <RoutingSelector value={routing ?? "A"} onChange={onRoutingChange} />
                    )}
                    <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                  </div>
                  <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                    {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  </span>
                </div>
              )}
              {/* For 16-channel amps: routing selector at left, impedance at right */}
              {is16Channel && (
                <div className="flex items-center justify-between pt-0.5">
                  {onRoutingChange && (
                    <RoutingSelector value={routing ?? "A"} onChange={onRoutingChange} />
                  )}
                  <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                    {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  </span>
                </div>
              )}
            </div>
          )}
          {salesMode && (
            <div className="flex-1 space-y-1">
              {output.enclosures.map((entry, i) => (
                <div key={i} className="text-sm text-gray-900 dark:text-gray-200">
                  {entry.count}x {entry.enclosure.enclosure}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        // For non-16-channel amps, show "Empty" label
        !is16Channel ? (
          <div className="flex-1 text-gray-400 dark:text-neutral-600 italic">Empty</div>
        ) : null
      )}
    </div>
  );
}

/** Card that groups multiple channels used by a single multi-channel enclosure (e.g., L2/L2D using Ch 1 & 2) */
function MultiChannelOutputCard({ outputs, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, hideEnclosureName = false, enclosureTypeMap, inputLetters, routings, onRoutingChange }: { outputs: OutputAllocation[]; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetters?: string[]; routings?: RoutingOption[]; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void }) {
  const channelCount = outputs.length;
  const primaryOutput = outputs[0];
  const is16Channel = ampOutputCount === 16;

  const minAllowed = primaryOutput.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE;
  const hasImpedanceError = !salesMode && outputs.some(o => o.impedanceOhms < minAllowed && o.impedanceOhms !== Infinity);

  // Get enclosure type background for the entire card
  const cardTypeBg = enclosureTypeMap && primaryOutput.enclosures[0]
    ? getEnclosureTypeBackground(primaryOutput.enclosures[0].enclosure.enclosure, enclosureTypeMap)
    : undefined;

  return (
    <div
      className={`flex flex-col rounded border p-2 text-xs min-w-0 ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
      }`}
      style={{
        gridColumn: `span ${channelCount}`,
        ...(cardTypeBg && !hasImpedanceError ? { backgroundColor: cardTypeBg } : {})
      }}
    >
      {/* Header row - only for non-16-channel amps (16ch shows Ch # inside each column) */}
      {!is16Channel && (
        <div className="mb-1 font-medium" style={getOutputTealStyle(primaryOutput.outputIndex, ampOutputCount)}>
          Output {primaryOutput.outputIndex + 1}
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
        </div>
      )}

      {/* Content area with all channels - 16ch uses 8 cols x 2 rows, others side by side */}
      {!salesMode && (
        <div className={`flex-1 flex flex-col ${!is16Channel ? "border-t" : ""} ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
          <div className={`flex-1 ${channelCount > 1 ? `grid ${is16Channel ? "gap-1" : "gap-2"}` : ""}`} style={channelCount > 1 ? { gridTemplateColumns: `repeat(${is16Channel && channelCount > 8 ? 8 : channelCount}, minmax(0, 1fr))` } : undefined}>
            {outputs.map((output, idx) => {
              const isSecondary = idx > 0;
              const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
              const hasChannelError = output.impedanceOhms < (output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && output.impedanceOhms !== Infinity;

              // For 16-channel amps (8 columns), don't add left border at start of row 2 (idx 8)
              const showLeftBorder = idx > 0 && (!is16Channel || idx % 8 !== 0);

              return (
                <div
                  key={output.outputIndex}
                  className={`flex flex-col min-w-0 ${showLeftBorder ? "border-l border-blue-200 dark:border-neutral-700 pl-2" : ""}`}
                  style={isSecondary ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : undefined}
                >
                  {/* Channel label - shown for all channels including 16-channel */}
                  <div className="font-medium truncate" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                    Ch {output.outputIndex + 1}
                    {hasChannelError && (
                      <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                    )}
                  </div>

                  {/* Separator line for each channel */}
                  <div className={`border-t my-1 ${hasChannelError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />

                  {/* Enclosure info */}
                  <div className="flex-1">
                    {output.enclosures.map((entry, i) => (
                      <div key={i}>
                        {!hideEnclosureName && (
                          <div className={`flex items-center gap-1 text-sm ${isSecondary ? "text-gray-400 dark:text-neutral-600" : "text-gray-900 dark:text-gray-200"}`}>
                            {entry.count}x {entry.enclosure.enclosure}
                          </div>
                        )}
                        {/* Signal type - always shown for uniform display */}
                        <div
                          className="text-[10px] font-medium"
                          style={getSignalTypeGoldStyle(idx, channelCount)}
                        >
                          {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Bottom row: routing selector at left, impedance at right */}
                  <div className="flex items-center justify-between pt-0.5">
                    {onRoutingChange ? (
                      <RoutingSelector value={routings?.[idx] ?? "A"} onChange={(value) => onRoutingChange(output.outputIndex, value)} />
                    ) : <span />}
                    <span className={hasChannelError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                      {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Cable length on its own line at the bottom */}
          {!is16Channel && primaryOutput.impedanceOhms !== Infinity && primaryOutput.impedanceOhms > 0 && (
            <div className="pt-1 text-[10px]">
              <CableLengthInfo impedanceOhms={primaryOutput.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
            </div>
          )}
        </div>
      )}

      {/* Sales mode */}
      {salesMode && (
        <div className="flex-1 space-y-1">
          {primaryOutput.enclosures.map((entry, i) => (
            <div key={i} className="text-sm text-gray-900 dark:text-gray-200">
              {entry.count}x {entry.enclosure.enclosure}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Card for a physical output that groups multiple amp channels (e.g., LA12X NL4 carrying 2 channels) */
function PhysicalOutputCard({ outputs, physicalIndex, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, enclosureTypeMap, inputLettersMap, routingMap, onRoutingChange }: { outputs: OutputAllocation[]; physicalIndex: number; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; enclosureTypeMap?: Map<string, number>; inputLettersMap?: string[]; routingMap?: Record<number, RoutingOption>; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void }) {
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

  // Check if ALL channels in this physical output are secondary multi-channel channels
  // If so, hide the output header since the enclosure info is shown on the primary channel's output
  const allSecondary = hasLoad && outputs.every((output) => {
    const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
    if (!isMultiChannel) return false;
    const channelsPerUnit = output.enclosures[0]?.enclosure.signal_channels.length ?? 1;
    return (output.outputIndex % channelsPerUnit) > 0;
  });

  // Get enclosure type background for the entire card (based on first enclosure in this physical output)
  const firstEnclosure = outputs.find(o => o.enclosures.length > 0)?.enclosures[0]?.enclosure;
  const cardTypeBg = hasLoad && firstEnclosure && enclosureTypeMap
    ? getEnclosureTypeBackground(firstEnclosure.enclosure, enclosureTypeMap)
    : undefined;

  return (
    <div
      className={`rounded border p-2 text-xs ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? allSecondary
            ? "border-blue-200/60 bg-blue-50/50 dark:border-neutral-700 dark:bg-neutral-800/50"
            : "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
      style={
        hasImpedanceError
          ? undefined
          : hasLoad && cardTypeBg
          ? {
              backgroundColor: cardTypeBg,
              ...(allSecondary ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : {})
            }
          : allSecondary
          ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' }
          : undefined
      }
    >
      <div className={`mb-1 font-medium ${allSecondary ? "invisible" : ""}`} style={getOutputTealStyle(physicalIndex, ampOutputCount / 2)}>
        Output {physicalIndex + 1}
        {outputs.length >= 2 && outputs.filter(o => o.totalEnclosures > 0).length >= 2 ? (
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">
            NL4 <span className="mx-0.5">&rarr;</span> NL4/NL2_Y <span className="mx-0.5">&rarr;</span> NL2 ({outputs.length})
          </span>
        ) : (
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
        )}
      </div>
      {hasLoad ? (
        <>
          {!salesMode ? (
            <div className={`border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
              {(() => {
                // Group outputs by multi-channel enclosures within this physical output
                const rendered = new Set<number>();
                const elements: React.ReactNode[] = [];
                const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;

                for (let outputIdx = 0; outputIdx < outputs.length; outputIdx++) {
                  const output = outputs[outputIdx];
                  if (rendered.has(output.outputIndex)) continue;

                  const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
                  const channelsPerUnit = output.enclosures[0]?.enclosure.signal_channels.length ?? 1;

                  if (isMultiChannel && channelsPerUnit > 1 && output.totalEnclosures > 0) {
                    // Find all channels in this physical output that belong to this multi-channel group
                    const groupOutputs: OutputAllocation[] = [output];
                    rendered.add(output.outputIndex);

                    // Look for subsequent channels in this physical output that are part of the same enclosure
                    for (let i = outputIdx + 1; i < outputs.length && groupOutputs.length < channelsPerUnit; i++) {
                      const nextOutput = outputs[i];
                      if (nextOutput.enclosures.length > 0 &&
                          nextOutput.enclosures[0].enclosure.enclosure === output.enclosures[0].enclosure.enclosure) {
                        groupOutputs.push(nextOutput);
                        rendered.add(nextOutput.outputIndex);
                      }
                    }

                    // Render combined multi-channel card within physical output
                    const isFirstInPhysical = outputIdx === 0;

                    elements.push(
                      <div
                        key={output.outputIndex}
                        className={`flex flex-col rounded -mx-1 px-1 ${!isFirstInPhysical ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
                      >
                        {/* Channel content side by side */}
                        <div className={`flex-1 ${groupOutputs.length > 1 ? "grid gap-2" : ""}`} style={groupOutputs.length > 1 ? { gridTemplateColumns: `repeat(${groupOutputs.length}, 1fr)` } : undefined}>
                          {groupOutputs.map((grpOutput, idx) => {
                            const isSecondary = idx > 0;
                            const hasChannelError = grpOutput.impedanceOhms < (grpOutput.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && grpOutput.impedanceOhms !== Infinity;
                            const posInGroup = grpOutput.outputIndex % channelsPerUnit;

                            return (
                              <div
                                key={grpOutput.outputIndex}
                                className={`flex flex-col ${idx > 0 ? "border-l border-blue-200 dark:border-neutral-700 pl-2" : ""}`}
                                style={isSecondary ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : undefined}
                              >
                                <div className="font-medium" style={getChannelPurpleStyle(grpOutput.outputIndex, ampOutputCount)}>
                                  Ch {grpOutput.outputIndex + 1}
                                  {hasChannelError && (
                                    <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                                  )}
                                </div>
                                <div className="flex-1">
                                  {grpOutput.enclosures.map((entry, i) => (
                                    <div key={i}>
                                      <div className={`text-sm ${isSecondary ? "text-gray-400 dark:text-neutral-600" : "text-gray-900 dark:text-gray-200"}`}>
                                        {entry.count}x {entry.enclosure.enclosure}
                                      </div>
                                      <div
                                        className="text-[10px] font-medium"
                                        style={getSignalTypeGoldStyle(posInGroup, channelsPerUnit)}
                                      >
                                        {entry.enclosure.signal_channels[posInGroup]}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                {/* Bottom row: routing selector at left, impedance at right (cable length shown once below) */}
                                <div className="flex items-end justify-between pt-0.5 text-[10px]">
                                  {onRoutingChange ? (
                                    <RoutingSelector value={routingMap?.[grpOutput.outputIndex] ?? "A"} onChange={(value) => onRoutingChange(grpOutput.outputIndex, value)} />
                                  ) : <span />}
                                  <span className={hasChannelError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                                    {grpOutput.impedanceOhms === Infinity ? "" : `${grpOutput.impedanceOhms}Ω`}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* Cable length on its own line at the bottom for combined card */}
                        {groupOutputs[0].impedanceOhms !== Infinity && groupOutputs[0].impedanceOhms > 0 && (
                          <div className="pt-1 text-[10px]">
                            <CableLengthInfo impedanceOhms={groupOutputs[0].impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                          </div>
                        )}
                      </div>
                    );
                  } else {
                    // Single-channel outputs - collect all remaining channels in this physical output
                    // and render them side by side like multi-channel enclosures
                    const groupOutputs: OutputAllocation[] = [];
                    for (let i = outputIdx; i < outputs.length; i++) {
                      const o = outputs[i];
                      if (!rendered.has(o.outputIndex)) {
                        const oIsMultiChannel = o.enclosures.some(e => e.enclosure.signal_channels.length > 1);
                        if (!oIsMultiChannel) {
                          groupOutputs.push(o);
                          rendered.add(o.outputIndex);
                        }
                      }
                    }

                    if (groupOutputs.length === 0) continue;

                    const isFirstInPhysical = outputIdx === 0;
                    // Find the first output with load for cable length display
                    const firstWithLoad = groupOutputs.find(o => o.totalEnclosures > 0);

                    elements.push(
                      <div
                        key={output.outputIndex}
                        className={`flex flex-col rounded -mx-1 px-1 ${!isFirstInPhysical ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
                      >
                        {/* Channel content side by side */}
                        <div className={`flex-1 ${groupOutputs.length > 1 ? "grid gap-2" : ""}`} style={groupOutputs.length > 1 ? { gridTemplateColumns: `repeat(${groupOutputs.length}, 1fr)` } : undefined}>
                          {groupOutputs.map((grpOutput, idx) => {
                            const hasChannelError = grpOutput.impedanceOhms < (grpOutput.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && grpOutput.impedanceOhms !== Infinity;
                            const hasLoad = grpOutput.totalEnclosures > 0;
                            const impedanceAboveRated = hasLoad && grpOutput.impedanceOhms !== Infinity && grpOutput.impedanceOhms > maxRated;

                            return (
                              <div
                                key={grpOutput.outputIndex}
                                className={`flex flex-col ${idx > 0 ? "border-l border-blue-200 dark:border-neutral-700 pl-2" : ""}`}
                              >
                                <div className="font-medium" style={getChannelPurpleStyle(grpOutput.outputIndex, ampOutputCount)}>
                                  Ch {grpOutput.outputIndex + 1}
                                  {hasChannelError && (
                                    <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                                  )}
                                </div>
                                {hasLoad ? (
                                  <>
                                    <div className="flex-1">
                                      {grpOutput.enclosures.map((entry, i) => (
                                        <div key={i}>
                                          <div className="flex items-center gap-1 text-sm text-gray-900 dark:text-gray-200">
                                            {entry.count}x {entry.enclosure.enclosure}
                                            {impedanceAboveRated && (
                                              <>
                                                <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                                                  <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                                                </svg>
                                                {onAdjustEnclosure && (
                                                  <button
                                                    onClick={() => onAdjustEnclosure(entry.enclosure.enclosure, 1)}
                                                    className="ml-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:hover:bg-amber-900/60"
                                                    title="Add 1 more for recommended load"
                                                  >
                                                    + 1
                                                  </button>
                                                )}
                                              </>
                                            )}
                                          </div>
                                          <div
                                            className="text-[10px] font-medium"
                                            style={getSignalTypeGoldStyle(0, 1)}
                                          >
                                            {entry.enclosure.signal_channels[grpOutput.outputIndex % entry.enclosure.signal_channels.length]}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                    {/* Routing selector at left, impedance at right */}
                                    <div className="flex items-end justify-between pt-0.5 text-[10px]">
                                      {onRoutingChange ? (
                                        <RoutingSelector value={routingMap?.[grpOutput.outputIndex] ?? "A"} onChange={(value) => onRoutingChange(grpOutput.outputIndex, value)} />
                                      ) : <span />}
                                      <span className={hasChannelError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                                        {grpOutput.impedanceOhms === Infinity ? "" : `${grpOutput.impedanceOhms}Ω`}
                                      </span>
                                    </div>
                                  </>
                                ) : (
                                  /* Empty channel - just show the header */
                                  <div className="flex-1" />
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {/* Cable length on its own line at the bottom for combined card */}
                        {firstWithLoad && firstWithLoad.impedanceOhms !== Infinity && firstWithLoad.impedanceOhms > 0 && (
                          <div className="pt-1 text-[10px]">
                            <CableLengthInfo impedanceOhms={firstWithLoad.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                          </div>
                        )}
                      </div>
                    );
                  }
                }

                return elements;
              })()}
            </div>
          ) : (
            <div className="space-y-1">
              {Array.from(enclosureTotals.values()).map((entry, i) => {
                const imageUrl = getEnclosureImage(entry.enclosure.enclosure, entry.count);
                return (
                  <div key={i} className="flex items-center gap-2 text-gray-900 dark:text-gray-200">
                    {imageUrl && (
                      <img src={imageUrl} alt={entry.enclosure.enclosure} className="h-6 w-6 object-contain" />
                    )}
                    <span>{entry.count}x {entry.enclosure.enclosure}</span>
                  </div>
                );
              })}
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
            {Array.from(enclosureTotals.entries()).map(([name, total]) => {
              const imageUrl = getEnclosureImage(name, total);
              return (
                <div key={name} className="flex items-center gap-2">
                  {imageUrl && (
                    <img src={imageUrl} alt={name} className="h-6 w-6 object-contain" />
                  )}
                  <span>{total}x {name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AmpCard({ instance: rawInstance, salesMode = false, cableGaugeMm2, useFeet, onAdjustEnclosure, packed, spread, onTogglePacked, onToggleSpread, isLocked = false, onLock, onUnlock }: { instance: AmpInstance; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packed: boolean; spread: boolean; onTogglePacked: () => void; onToggleSpread: () => void; isLocked?: boolean; onLock?: () => void; onUnlock?: () => void }) {

  // Compute the repacked/spread instance based on mode
  const instance = useMemo(() => {
    console.log(`[AmpCard useMemo] ${rawInstance.id}: packed=${packed}, spread=${spread}`);
    if (packed && spread) {
      // Prioritize Channels: pack first, then spread
      console.log(`[AmpCard useMemo] ${rawInstance.id}: Applying spread(repack(...))`);
      return spreadAmpInstance(repackAmpInstance(rawInstance));
    } else if (packed) {
      console.log(`[AmpCard useMemo] ${rawInstance.id}: Applying repack only`);
      return repackAmpInstance(rawInstance);
    }
    console.log(`[AmpCard useMemo] ${rawInstance.id}: Using rawInstance (balanced)`);
    return rawInstance;
  }, [packed, spread, rawInstance]);

  const ampOutputCount = instance.ampConfig.outputs;
  const is16ChannelAmp = ampOutputCount === 16;
  const physicalOutputCount = instance.ampConfig.physicalOutputs;
  const usePhysicalGrouping = physicalOutputCount < ampOutputCount;
  const hasAnyImpedanceError = !salesMode && instance.outputs.some(
    (o) => o.impedanceOhms < (o.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && o.impedanceOhms !== Infinity
  );
  const enclosureTypeCount = countEnclosureTypes(instance);
  const isAtMaxTypes = enclosureTypeCount >= MAX_ENCLOSURE_TYPES_PER_AMP;

  // Only show toggle when there are enclosures to redistribute
  const showPackToggle = rawInstance.totalEnclosures > 1 && !salesMode;

  // Group channels into physical outputs when needed (e.g., LA12X: 4 channels -> 2 NL4 connectors)
  const physicalGroups = usePhysicalGrouping
    ? groupByPhysicalOutputs(instance.outputs, ampOutputCount, physicalOutputCount)
    : null;

  // Build enclosure type map for coloring
  const enclosureTypeMap = useMemo(() => buildEnclosureTypeMap(instance), [instance]);

  // Compute input letters for each channel (A, B, C, D based on signal groups)
  const inputLettersMap = useMemo(() => instance.outputs.map((_, i) => getInputLetter(instance.outputs, i)), [instance.outputs]);

  // Input routing state per channel (default: cycle A→B→C→D)
  const [routingMap, setRoutingMap] = useState<Record<number, RoutingOption>>(() => {
    const initial: Record<number, RoutingOption> = {};
    const letters: RoutingOption[] = ["A", "B", "C", "D"];
    for (let i = 0; i < instance.outputs.length; i++) {
      initial[i] = letters[i % 4];
    }
    return initial;
  });

  // Handler to update routing for a specific channel
  const handleRoutingChange = (channelIndex: number, value: RoutingOption) => {
    setRoutingMap(prev => ({ ...prev, [channelIndex]: value }));
  };

  // Check if any output has impedance at or above max rated (for annotation legend)
  // Skip multi-channel enclosure outputs — their per-section impedance is fixed by speaker design
  const maxRated = instance.ampConfig.ratedImpedances.length > 0 ? Math.max(...instance.ampConfig.ratedImpedances) : Infinity;
  const hasAboveRatedOutput = instance.outputs.some(
    (o) => o.totalEnclosures > 0 && o.impedanceOhms !== Infinity && o.impedanceOhms > maxRated
      && !o.enclosures.some(e => e.enclosure.signal_channels.length > 1)
  );

  // Check if this is a 16-channel amp with only L2 or L2D enclosures filling all channels
  // If so, show enclosure name as a centered header above the grid
  const l2HeaderEnclosure = useMemo(() => {
    if (ampOutputCount !== 16) return null;

    // Get unique enclosure names on this amp
    const enclosureNames = new Set<string>();
    for (const output of instance.outputs) {
      for (const entry of output.enclosures) {
        enclosureNames.add(entry.enclosure.enclosure);
      }
    }

    // Check if it's only L2, L2D, or "L2 / L2D" (exactly one type)
    if (enclosureNames.size !== 1) return null;
    const name = Array.from(enclosureNames)[0];
    if (name !== "L2" && name !== "L2D" && name !== "L2 / L2D") return null;

    // Check if all 16 channels are used
    const usedChannels = instance.outputs.filter(o => o.totalEnclosures > 0).length;
    if (usedChannels !== 16) return null;

    return name;
  }, [ampOutputCount, instance.outputs]);

  // Check if all channels are occupied by a single multi-channel enclosure spanning all channels
  // (e.g., K2 on LA12X uses all 4 channels) - if so, render as single unified card instead of physical groups
  const singleSpanningEnclosure = useMemo(() => {
    if (!usePhysicalGrouping) return null;

    // Check if all channels have load
    const channelsWithLoad = instance.outputs.filter(o => o.totalEnclosures > 0);
    if (channelsWithLoad.length !== ampOutputCount) return null;

    // Check if all channels have the same enclosure type
    const firstEnclosure = channelsWithLoad[0]?.enclosures[0]?.enclosure;
    if (!firstEnclosure) return null;

    const allSameEnclosure = channelsWithLoad.every(o =>
      o.enclosures.length === 1 &&
      o.enclosures[0].enclosure.enclosure === firstEnclosure.enclosure
    );
    if (!allSameEnclosure) return null;

    // Check if it's a multi-channel enclosure spanning all or most channels
    const channelsPerUnit = firstEnclosure.signal_channels?.length ?? 1;
    if (channelsPerUnit < 2) return null;

    return firstEnclosure;
  }, [usePhysicalGrouping, instance.outputs, ampOutputCount]);

  return (
    <div className={`rounded-lg border shadow-sm ${
      hasAnyImpedanceError ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30" : "border-gray-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    }`}>
      {/* Amp Header */}
      <div className={`border-b px-4 py-1.5 ${
        hasAnyImpedanceError ? "border-red-200 bg-red-100 dark:border-red-800 dark:bg-red-950/50" : "border-gray-200 bg-gray-100 dark:border-neutral-700 dark:bg-neutral-800"
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Lock/Unlock button */}
            {isLocked ? (
              <button
                onClick={onUnlock}
                className="rounded p-1 transition-colors"
                style={{ backgroundColor: 'rgba(181, 158, 95, 0.2)', color: '#b59e5f' }}
                title="Unlock this amplifier configuration"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              </button>
            ) : onLock && (
              <button
                onClick={onLock}
                className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-300 transition-colors"
                title="Lock this amplifier configuration"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            <span className="font-bold text-gray-900 dark:text-gray-200">
              {instance.ampConfig.model}
            </span>
            {instance.ampConfig.mode && (
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300">
                {instance.ampConfig.mode}
              </span>
            )}
            {showPackToggle && (
              <>
                <button
                  onClick={onTogglePacked}
                  className={`ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    packed
                      ? "bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:hover:bg-purple-900/60"
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-600"
                  }`}
                  title={packed ? "Switch to balanced mode (spread across outputs)" : "Switch to packed mode (minimize outputs used)"}
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    {packed ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                    )}
                  </svg>
                  {packed ? "Packed" : "Balanced"}
                </button>
                {packed && (
                  <button
                    onClick={onToggleSpread}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      spread
                        ? "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300 dark:hover:bg-green-900/60"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-600"
                    }`}
                    title={spread ? "Disable channel prioritization" : "Spread enclosures across channels (1 per channel when possible)"}
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
                    </svg>
                    Prioritize Channels
                  </button>
                )}
              </>
            )}
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
          {/* L2/L2D header when all 16 channels are used */}
          {l2HeaderEnclosure && (
            <div className="mb-3 text-center">
              <span className="text-lg font-bold text-gray-900 dark:text-gray-200">{l2HeaderEnclosure}</span>
            </div>
          )}
          {usePhysicalGrouping && physicalGroups && !singleSpanningEnclosure ? (
            <div className={`grid gap-2 ${
              physicalOutputCount === 2 ? "grid-cols-2" : physicalOutputCount <= 4 ? "grid-cols-4" : "grid-cols-8"
            }`}>
              {physicalGroups.map((group, i) => (
                <PhysicalOutputCard
                  key={i}
                  outputs={group}
                  physicalIndex={i}
                  ampOutputCount={ampOutputCount}
                  salesMode={salesMode}
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  ratedImpedances={instance.ampConfig.ratedImpedances}
                  onAdjustEnclosure={packed ? undefined : onAdjustEnclosure}
                  enclosureTypeMap={enclosureTypeMap}
                  inputLettersMap={inputLettersMap}
                  routingMap={routingMap}
                  onRoutingChange={is16ChannelAmp ? undefined : handleRoutingChange}
                />
              ))}
            </div>
          ) : singleSpanningEnclosure ? (
            /* All channels occupied by same multi-channel enclosure - render as single unified card */
            <div className={`grid gap-2 ${ampOutputCount <= 4 ? "grid-cols-4" : "grid-cols-8"}`}>
              <MultiChannelOutputCard
                outputs={instance.outputs}
                ampOutputCount={ampOutputCount}
                salesMode={salesMode}
                cableGaugeMm2={cableGaugeMm2}
                useFeet={useFeet}
                ratedImpedances={instance.ampConfig.ratedImpedances}
                onAdjustEnclosure={packed ? undefined : onAdjustEnclosure}
                hideEnclosureName={false}
                enclosureTypeMap={enclosureTypeMap}
                inputLetters={inputLettersMap}
                routings={instance.outputs.map((_, i) => routingMap[i])}
                onRoutingChange={is16ChannelAmp ? undefined : handleRoutingChange}
              />
            </div>
          ) : (
            <div className={`grid ${
              ampOutputCount <= 4
                ? "gap-2 grid-cols-4"
                : "gap-1 grid-cols-8"
            }`}>
              {(() => {
                // Group outputs by multi-channel enclosures
                const rendered = new Set<number>();
                const elements: React.ReactNode[] = [];

                for (const output of instance.outputs) {
                  if (rendered.has(output.outputIndex)) continue;

                  const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
                  const channelsPerUnit = output.enclosures[0]?.enclosure.signal_channels.length ?? 1;

                  if (isMultiChannel && channelsPerUnit > 1 && output.totalEnclosures > 0) {
                    // This is a primary channel of a multi-channel enclosure
                    // Find all channels that belong to this group
                    const groupStartIndex = output.outputIndex;
                    const groupOutputs: OutputAllocation[] = [];

                    for (let i = 0; i < channelsPerUnit && groupStartIndex + i < instance.outputs.length; i++) {
                      const groupOutput = instance.outputs[groupStartIndex + i];
                      if (groupOutput.enclosures.length > 0 &&
                          groupOutput.enclosures[0].enclosure.enclosure === output.enclosures[0].enclosure.enclosure) {
                        groupOutputs.push(groupOutput);
                        rendered.add(groupStartIndex + i);
                      }
                    }

                    // Render grouped multi-channel card
                    elements.push(
                      <MultiChannelOutputCard
                        key={output.outputIndex}
                        outputs={groupOutputs}
                        ampOutputCount={ampOutputCount}
                        salesMode={salesMode}
                        cableGaugeMm2={cableGaugeMm2}
                        useFeet={useFeet}
                        ratedImpedances={instance.ampConfig.ratedImpedances}
                        onAdjustEnclosure={packed ? undefined : onAdjustEnclosure}
                        hideEnclosureName={!!l2HeaderEnclosure}
                        enclosureTypeMap={enclosureTypeMap}
                        inputLetters={groupOutputs.map(o => inputLettersMap[o.outputIndex])}
                        routings={groupOutputs.map(o => routingMap[o.outputIndex])}
                        onRoutingChange={is16ChannelAmp ? undefined : handleRoutingChange}
                      />
                    );
                  } else {
                    // Single-channel output - render normally
                    rendered.add(output.outputIndex);
                    elements.push(
                      <OutputCard
                        key={output.outputIndex}
                        output={output}
                        ampOutputCount={ampOutputCount}
                        salesMode={salesMode}
                        cableGaugeMm2={cableGaugeMm2}
                        useFeet={useFeet}
                        ratedImpedances={instance.ampConfig.ratedImpedances}
                        onAdjustEnclosure={packed ? undefined : onAdjustEnclosure}
                        isSecondaryChannel={false}
                        hideEnclosureName={!!l2HeaderEnclosure}
                        enclosureTypeMap={enclosureTypeMap}
                        inputLetter={inputLettersMap[output.outputIndex]}
                        routing={routingMap[output.outputIndex]}
                        onRoutingChange={is16ChannelAmp ? undefined : (value) => handleRoutingChange(output.outputIndex, value)}
                      />
                    );
                  }
                }

                return elements;
              })()}
            </div>
          )}
          {hasAboveRatedOutput && !packed && (
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
function ZoneSolutionSection({ solution, salesMode, cableGaugeMm2, useFeet, onAdjustEnclosure, lockedAmpIds, onLockAmpInstance, onUnlockAmpInstance }: { solution: SolverSolution; salesMode: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; lockedAmpIds?: Set<string>; onLockAmpInstance?: (ampInstance: AmpInstance) => void; onUnlockAmpInstance?: (ampInstanceId: string) => void }) {
  // Track packed/spread state per amp index (independent per amp)
  const [packedMap, setPackedMap] = useState<Record<number, boolean>>({});
  const [spreadMap, setSpreadMap] = useState<Record<number, boolean>>({});

  // Track which amp indices have been initialized
  const initializedIndicesRef = useRef<Set<number>>(new Set());

  // Initialize settings for new amps (copy from previous amp, then become independent)
  useEffect(() => {
    const ampCount = solution.ampInstances.length;
    const newPackedEntries: Record<number, boolean> = {};
    const newSpreadEntries: Record<number, boolean> = {};
    let hasNewEntries = false;

    for (let i = 0; i < ampCount; i++) {
      if (!initializedIndicesRef.current.has(i)) {
        // New amp - copy settings from previous amp (or default to false for first)
        const prevPacked = i > 0 ? (packedMap[i - 1] ?? false) : false;
        const prevSpread = i > 0 ? (spreadMap[i - 1] ?? false) : false;
        newPackedEntries[i] = prevPacked;
        newSpreadEntries[i] = prevSpread;
        initializedIndicesRef.current.add(i);
        hasNewEntries = true;
      }
    }

    if (hasNewEntries) {
      setPackedMap(prev => ({ ...prev, ...newPackedEntries }));
      setSpreadMap(prev => ({ ...prev, ...newSpreadEntries }));
    }
  }, [solution.ampInstances.length, packedMap, spreadMap]);

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
      <div className={`rounded-lg border px-3 py-2 ${
        hasErrors
          ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
          : "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
      }`}>
        <div className="flex items-center justify-between gap-4 text-sm">
          <h3 className={`font-bold ${hasErrors ? "text-amber-800 dark:text-amber-500" : "text-green-800 dark:text-green-500"}`}>
            {hasErrors ? "Configuration (with errors)" : "Recommended Configuration"}
          </h3>
          <div className="flex items-center gap-4">
            <span className={hasErrors ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500"}>
              <span className={`font-bold text-base ${hasErrors ? "text-amber-900 dark:text-amber-400" : "text-green-900 dark:text-green-400"}`}>{solution.summary.totalAmplifiers}</span> amp{solution.summary.totalAmplifiers !== 1 ? "s" : ""}
            </span>
            <span className={hasErrors ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500"}>
              <span className={`font-bold text-base ${hasErrors ? "text-amber-900 dark:text-amber-400" : "text-green-900 dark:text-green-400"}`}>{solution.summary.totalEnclosuresAllocated}</span> encl.
            </span>
          </div>
        </div>
        <div className={`mt-1 text-xs ${
          hasErrors ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"
        }`}>
          {solution.summary.ampConfigsUsed.map((c, i) => (
            <span key={c.key}>
              {i > 0 && ", "}
              {c.model}
              {c.mode && ` (${c.mode})`}
            </span>
          ))}
        </div>
      </div>

      {/* Individual Amp Cards */}
      <div className="space-y-4">
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
          solution.ampInstances.map((instance, index) => {
            // Use map values directly (each amp has independent state after initialization)
            const packed = packedMap[index] ?? false;
            const spread = spreadMap[index] ?? false;

            const isLocked = lockedAmpIds?.has(instance.id) ?? false;

            return (
              <AmpCard
                key={instance.id}
                instance={instance}
                salesMode={salesMode}
                cableGaugeMm2={cableGaugeMm2}
                useFeet={useFeet}
                onAdjustEnclosure={onAdjustEnclosure}
                packed={packed}
                spread={spread}
                onTogglePacked={() => {
                  setPackedMap(prev => {
                    const wasPacked = prev[index] ?? false;
                    if (wasPacked) {
                      // When turning off packed, also turn off spread
                      setSpreadMap(s => ({ ...s, [index]: false }));
                    }
                    return { ...prev, [index]: !wasPacked };
                  });
                }}
                onToggleSpread={() => {
                  setSpreadMap(prev => ({ ...prev, [index]: !(prev[index] ?? false) }));
                }}
                isLocked={isLocked}
                onLock={() => onLockAmpInstance?.(instance)}
                onUnlock={() => onUnlockAmpInstance?.(instance.id)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

export default function SolverResults({ zoneSolutions, activeZoneId, salesMode = false, cableGaugeMm2 = 2.5, useFeet = true, onAdjustEnclosure, onLockAmpInstance, onUnlockAmpInstance }: SolverResultsProps) {
  // Find the active zone's solution
  const activeZoneSolution = zoneSolutions.find((zs) => zs.zone.id === activeZoneId);
  const activeSolution = activeZoneSolution?.solution ?? null;

  if (!activeSolution) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-neutral-700 dark:text-neutral-500">
        <p>Add enclosures to see amplifier recommendations.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Active Zone Results */}
      <ZoneSolutionSection
        solution={activeSolution}
        salesMode={salesMode}
        cableGaugeMm2={cableGaugeMm2}
        useFeet={useFeet}
        onAdjustEnclosure={onAdjustEnclosure}
        lockedAmpIds={new Set(activeZoneSolution?.zone.lockedAmpInstances.map(a => a.id) ?? [])}
        onLockAmpInstance={onLockAmpInstance}
        onUnlockAmpInstance={onUnlockAmpInstance}
      />
    </div>
  );
}
