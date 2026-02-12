import React, { useState, useMemo, useEffect, useRef } from "react"; // eslint-disable-line
import type { AmpInstance, OutputAllocation, ZoneWithSolution, SolverSolution, Enclosure } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS, getMaxCableLength, calculateCableLoss } from "../types";
import { getImpedanceErrors, repackAmpInstance, spreadAmpInstance } from "../solver/ampSolver";
import { getEnclosureImage } from "../utils/enclosureImages";
import CableLossChart from "./CableLossChart";
import {
  EnclosureDragDropProvider,
  useDraggableEnclosure,
  useDroppableChannel,
  useEnclosureDragState,
  type EnclosureMoveResult,
  type DraggableEnclosureData,
  type DroppableChannelData,
  type DropValidation,
} from "./EnclosureDragDrop";

interface SolverResultsProps {
  zoneSolutions: ZoneWithSolution[];
  activeZoneId: string;
  salesMode?: boolean;
  rackMode?: boolean;
  cableGaugeMm2?: number;
  useFeet?: boolean;
  onAdjustEnclosure?: (enclosureName: string, delta: number) => void;
  onLockAmpInstance?: (ampInstance: AmpInstance) => void;
  onUnlockAmpInstance?: (ampInstanceId: string) => void;
  onCombineLockedRacks?: (ampIds: string[]) => void;
  onMoveEnclosure?: (move: EnclosureMoveResult) => void;
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

/**
 * Get the number of amp channels required per enclosure unit.
 * Checks for amp-specific overrides (e.g., Syva Low Syva uses 1 channel on LA12X but 2 on other amps).
 */
function getChannelsPerUnit(enclosure: Enclosure | undefined, ampConfigKey?: string): number {
  if (!enclosure) return 1;
  if (ampConfigKey && enclosure.signal_channels_override?.[ampConfigKey] !== undefined) {
    return enclosure.signal_channels_override[ampConfigKey];
  }
  return enclosure.signal_channels.length;
}

/** Input letters for routing (A, B, C, D for 4-channel, extends for 16-channel) */
const INPUT_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

/**
 * Get input routing letter for a channel based on which signal group it belongs to.
 * For 4-channel amps: ABCD (4 separate), AABB (2 groups), AAAA (1 group), etc.
 * Groups are determined by multi-channel enclosures sharing the same input.
 */
function getInputLetter(outputs: OutputAllocation[], channelIndex: number, ampConfigKey?: string): string {
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
    const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
    const channelsPerUnit = getChannelsPerUnit(output.enclosures[0]?.enclosure, ampConfigKey);
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
        <div className="absolute bottom-full left-0 mb-1 z-[9999] rounded border border-gray-200 bg-white/30 shadow-lg dark:border-neutral-700 dark:bg-neutral-800/30 backdrop-blur-sm min-w-[90px]">
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

const METERS_PER_FOOT = 0.3048;

// Output colors for cable loss chart (matches CableLossChart.tsx palette)
const OUTPUT_COLORS_LIGHT = ["#4A9B9B", "#8B7FB8", "#7B9B7B", "#B87F8B", "#B89B7F"];
const OUTPUT_COLORS_DARK = ["#5DBDBD", "#A599D4", "#96B896", "#D499A6", "#D4B899"];

/** Compact cable length input for per-output cable run distance */
function CableLengthInput({
  lengthMeters,
  onChange,
  useFeet,
  outputIndex,
}: {
  lengthMeters: number;
  onChange: (meters: number) => void;
  useFeet: boolean;
  outputIndex?: number;
}) {
  const displayValue = useFeet
    ? Math.round(lengthMeters / METERS_PER_FOOT)
    : Math.round(lengthMeters);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value) || 0;
    const meters = useFeet ? val * METERS_PER_FOOT : val;
    onChange(Math.max(0, meters));
  };

  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const outputColor = outputIndex !== undefined
    ? (isDark ? OUTPUT_COLORS_DARK : OUTPUT_COLORS_LIGHT)[outputIndex % OUTPUT_COLORS_LIGHT.length]
    : undefined;

  return (
    <div className="flex items-center gap-1 text-[10px]">
      <span
        className={outputColor ? "" : "text-gray-500 dark:text-neutral-500"}
        style={outputColor ? { color: outputColor } : undefined}
      >
        Cable:
      </span>
      <input
        type="number"
        min="0"
        step={useFeet ? "5" : "1"}
        value={displayValue || ""}
        onChange={handleChange}
        placeholder="0"
        className="w-12 rounded border border-gray-300 bg-white px-1 py-0.5 text-center text-[10px] text-gray-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-200 focus:border-blue-500 focus:outline-none"
      />
      <span className="text-gray-400 dark:text-neutral-500">{useFeet ? "ft" : "m"}</span>
    </div>
  );
}

/** Displays cable insertion loss (dB) and effective damping factor with color coding */
function CableLossDisplay({
  impedanceOhms,
  cableLengthMeters,
  gaugeMm2,
}: {
  impedanceOhms: number;
  cableLengthMeters: number;
  gaugeMm2: number;
}) {
  if (impedanceOhms === Infinity || impedanceOhms <= 0 || cableLengthMeters <= 0) return null;

  const result = calculateCableLoss(impedanceOhms, cableLengthMeters, gaugeMm2);
  if (!result) return null;

  const absLoss = Math.abs(result.lossDb);

  const lossColor =
    absLoss < 0.4
      ? "text-green-600 dark:text-green-500"
      : absLoss <= 1.0
        ? "text-amber-600 dark:text-amber-500"
        : "text-red-600 dark:text-red-500";

  const dfColor =
    result.dampingFactor > 20
      ? "text-green-600 dark:text-green-500"
      : result.dampingFactor >= 10
        ? "text-amber-600 dark:text-amber-500"
        : "text-red-600 dark:text-red-500";

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={`font-medium ${lossColor}`}>
        {result.lossDb.toFixed(1)} dB
      </span>
      <span className={`font-medium ${dfColor}`}>
        DF {result.dampingFactor.toFixed(0)}
      </span>
    </div>
  );
}

/** Draggable enclosure count display - allows drag-and-drop between channels */
function DraggableEnclosureItem({
  enclosureName,
  count,
  ampId,
  channelIndex,
  impedanceOhms,
  isLocked,
  onAdjustEnclosure,
  impedanceAboveRated,
}: {
  enclosureName: string;
  count: number;
  ampId: string;
  channelIndex: number;
  impedanceOhms: number;
  isLocked: boolean;
  onAdjustEnclosure?: (enclosureName: string, delta: number) => void;
  impedanceAboveRated: boolean;
}) {
  const { ref, isDragging, dragProps, canDrag } = useDraggableEnclosure({
    enclosureName,
    ampId,
    channelIndex,
    impedanceOhms,
    isLocked,
    count,
  });

  return (
    <div
      ref={ref}
      {...dragProps}
      className={`flex items-center gap-1 text-sm text-gray-900 dark:text-gray-200 ${
        canDrag ? "cursor-grab active:cursor-grabbing" : ""
      } ${isDragging ? "opacity-50" : ""}`}
    >
      <span className={isDragging ? "line-through" : ""}>{count}x</span> {enclosureName}
      {impedanceAboveRated && (
        <>
          <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
          </svg>
          {onAdjustEnclosure && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdjustEnclosure(enclosureName, 1);
              }}
              className="ml-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:hover:bg-amber-900/60"
              title="Add 1 more for recommended load"
            >
              + 1
            </button>
          )}
        </>
      )}
    </div>
  );
}

function OutputCard({ output, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, isSecondaryChannel = false, hideEnclosureName = false, enclosureTypeMap, inputLetter, routing, onRoutingChange, ampConfigKey, ampId, ampModel, isLocked = false, cableLengthMeters = 0, onCableLengthChange }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; isSecondaryChannel?: boolean; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetter?: string; routing?: RoutingOption; onRoutingChange?: (value: RoutingOption) => void; ampConfigKey?: string; ampId?: string; ampModel?: string; isLocked?: boolean; cableLengthMeters?: number; onCableLengthChange?: (meters: number) => void }) {
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

  // Drag-drop: make this channel a drop target
  const currentEnclosures = output.enclosures.map(e => ({ name: e.enclosure.enclosure, count: e.count }));
  const { ref: dropRef, isOver: isDropOver, isValidTarget } = useDroppableChannel({
    ampId: ampId ?? "",
    ampModel: ampModel ?? "",
    channelIndex: output.outputIndex,
    isLocked: isLocked,
    currentEnclosures,
  });

  // Get global drag state to show visual feedback
  const { isDragging, activeData } = useEnclosureDragState();
  const showDropHighlight = isDragging && isValidTarget; // isValidTarget already checks isLocked

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
                const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                const posInGroup = output.outputIndex % channelsPerUnit;
                const totalInGroup = channelsPerUnit;
                const signalType = channelsPerUnit === 1
                  ? entry.enclosure.signal_channels.join("+")
                  : entry.enclosure.signal_channels[posInGroup];
                const channelName = channelsPerUnit > 1
                  ? entry.enclosure.signal_channel_names?.[signalType]
                  : undefined;
                return (
                  <div key={i}>
                    {!is16Channel && (
                      <div className="text-sm italic text-gray-400 dark:text-neutral-600">Channel allocated</div>
                    )}
                    {channelName && (
                      <div className="text-[10px] text-gray-400 dark:text-neutral-500">
                        {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                      </div>
                    )}
                    <div
                      className="text-[10px] font-medium"
                      style={getSignalTypeGoldStyle(posInGroup, totalInGroup)}
                    >
                      {signalType}
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
      ref={dropRef}
      className={`flex flex-col rounded border p-2 text-xs min-w-0 transition-all ${
        isDropOver && isValidTarget
          ? "border-blue-500 ring-2 ring-blue-500/50 bg-blue-100 dark:bg-blue-900/30"
          : showDropHighlight
          ? "border-dashed border-blue-400 dark:border-blue-600"
          : hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
      style={cardTypeBg && !hasImpedanceError && !isDropOver ? { backgroundColor: cardTypeBg } : undefined}
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
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">&rarr; NL4</span>
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
                <>
                  <div className="font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                    Ch {output.outputIndex + 1}
                    {hasImpedanceError && (
                      <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                    )}
                  </div>
                  <div className={`border-t my-1 ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />
                </>
              )}
              <div className="flex-1">
                {(() => {
                  const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                  const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
                  const impedanceAboveRated = !isMultiChannel && output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                  return output.enclosures.map((entry, i) => {
                    const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                    const posInGroup = output.outputIndex % (channelsPerUnit || 1);
                    const signalType = channelsPerUnit === 1
                      ? entry.enclosure.signal_channels.join("+")
                      : entry.enclosure.signal_channels[posInGroup];
                    const channelName = channelsPerUnit > 1
                      ? entry.enclosure.signal_channel_names?.[signalType]
                      : undefined;
                    return (
                      <div key={i}>
                        {/* Hide enclosure name when shown as header above (L2/L2D on 16ch) */}
                        {!hideEnclosureName && (
                          <DraggableEnclosureItem
                            enclosureName={entry.enclosure.enclosure}
                            count={entry.count}
                            ampId={ampId ?? ""}
                            channelIndex={output.outputIndex}
                            impedanceOhms={output.impedanceOhms}
                            isLocked={isLocked}
                            onAdjustEnclosure={onAdjustEnclosure}
                            impedanceAboveRated={impedanceAboveRated}
                          />
                        )}
                        {/* Component name for hybrid/multi-channel enclosures */}
                        {channelName && (
                          <div className="text-[10px] text-gray-400 dark:text-neutral-500">
                            {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                          </div>
                        )}
                        {/* Signal type - always shown for uniform display */}
                        <div
                          className="text-[10px] font-medium"
                          style={getSignalTypeGoldStyle(0, 1)}
                        >
                          {signalType}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
              {/* Bottom row: routing selector at left, cable length in middle (non-16ch), impedance at right */}
              {!is16Channel && (
                <div className="flex items-end justify-between pt-0.5 text-[10px]">
                  <div className="flex items-center gap-1">
                    {onRoutingChange && (
                      <RoutingSelector value={routing ?? "A"} onChange={onRoutingChange} />
                    )}

                  </div>
                  <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                    {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  </span>
                </div>
              )}
              {/* Cable loss: per-output length input + dB loss / damping factor */}
              {!is16Channel && output.impedanceOhms !== Infinity && output.impedanceOhms > 0 && onCableLengthChange && (
                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                  <CableLengthInput lengthMeters={cableLengthMeters} onChange={onCableLengthChange} useFeet={useFeet} outputIndex={output.outputIndex} />
                  <CableLossDisplay impedanceOhms={output.impedanceOhms} cableLengthMeters={cableLengthMeters} gaugeMm2={cableGaugeMm2} />
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
function MultiChannelOutputCard({ outputs, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, hideEnclosureName = false, enclosureTypeMap, inputLetters, routings, onRoutingChange, ampConfigKey, cableLengthMeters = 0, onCableLengthChange }: { outputs: OutputAllocation[]; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetters?: string[]; routings?: RoutingOption[]; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void; ampConfigKey?: string; cableLengthMeters?: number; onCableLengthChange?: (meters: number) => void }) {
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
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">&rarr; NL4</span>
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
                    {output.enclosures.map((entry, i) => {
                      const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                      const signalType = channelsPerUnit === 1
                        ? entry.enclosure.signal_channels.join("+")
                        : entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length];
                      const channelName = channelsPerUnit > 1
                        ? entry.enclosure.signal_channel_names?.[signalType]
                        : undefined;
                      return (
                        <div key={i}>
                          {!hideEnclosureName && (
                            isSecondary ? (
                              <div className="text-sm italic text-gray-400 dark:text-neutral-600">Channel allocated</div>
                            ) : (
                              <div className="flex items-center gap-1 text-sm text-gray-900 dark:text-gray-200">
                                {entry.count}x {entry.enclosure.enclosure}
                              </div>
                            )
                          )}
                          {/* Component name for hybrid/multi-channel enclosures */}
                          {channelName && (
                            <div className="text-[10px] text-gray-400 dark:text-neutral-500">
                              {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                            </div>
                          )}
                          {/* Signal type - always shown for uniform display */}
                          <div
                            className="text-[10px] font-medium"
                            style={getSignalTypeGoldStyle(idx, channelCount)}
                          >
                            {signalType}
                          </div>
                        </div>
                      );
                    })}
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
              {onCableLengthChange && (
                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                  <CableLengthInput lengthMeters={cableLengthMeters} onChange={onCableLengthChange} useFeet={useFeet} outputIndex={primaryOutput.outputIndex} />
                  <CableLossDisplay impedanceOhms={primaryOutput.impedanceOhms} cableLengthMeters={cableLengthMeters} gaugeMm2={cableGaugeMm2} />
                </div>
              )}
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
function PhysicalOutputCard({ outputs, physicalIndex, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, enclosureTypeMap, inputLettersMap, routingMap, onRoutingChange, ampConfigKey, cableLengths, ampId, onCableLengthChange }: { outputs: OutputAllocation[]; physicalIndex: number; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; enclosureTypeMap?: Map<string, number>; inputLettersMap?: string[]; routingMap?: Record<number, RoutingOption>; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void; ampConfigKey?: string; cableLengths?: Record<string, number>; ampId?: string; onCableLengthChange?: (outputIndex: number, meters: number) => void }) {
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
    const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
    if (!isMultiChannel) return false;
    const channelsPerUnit = getChannelsPerUnit(output.enclosures[0]?.enclosure, ampConfigKey);
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
        {(() => {
          // Check if Y-cable is needed: only when there are multiple SEPARATE enclosures
          // Multi-channel enclosures (like Syva Low Syva) use multiple channels but are 1 physical unit
          const loadedOutputs = outputs.filter(o => o.totalEnclosures > 0);
          if (loadedOutputs.length === 0) {
            return null; // No speakers connected - no NL4 indicator
          }
          if (outputs.length < 2 || loadedOutputs.length < 2) {
            return <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">&rarr; NL4</span>;
          }

          // Check if all loaded outputs are part of the same multi-channel enclosure
          const firstOutput = loadedOutputs[0];
          const isMultiChannel = firstOutput.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
          if (isMultiChannel) {
            const channelsPerUnit = getChannelsPerUnit(firstOutput.enclosures[0]?.enclosure, ampConfigKey);
            const firstEnclosureName = firstOutput.enclosures[0]?.enclosure.enclosure;
            const allSameMultiChannel = loadedOutputs.every(o =>
              o.enclosures.length > 0 && o.enclosures[0].enclosure.enclosure === firstEnclosureName
            );
            // Check if stacked (count > 1 means multiple physical units on same channels)
            const isStacked = loadedOutputs.some(o => o.enclosures.some(e => e.count > 1));
            // If all channels belong to the same multi-channel enclosure and only 1 unit, no Y-cable
            if (allSameMultiChannel && loadedOutputs.length <= channelsPerUnit && !isStacked) {
              return <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">&rarr; NL4</span>;
            }
            // Stacked multi-channel: need Y-cable splitter
            if (allSameMultiChannel && isStacked) {
              return (
                <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">
                  &rarr; NL4 <span className="mx-0.5">&rarr;</span> NL4/Y
                </span>
              );
            }
          }

          return <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">&rarr; NL4</span>;
        })()}
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

                  const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
                  const channelsPerUnit = getChannelsPerUnit(output.enclosures[0]?.enclosure, ampConfigKey);

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
                                <div className={`border-t my-1 ${hasChannelError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />
                                <div className="flex-1">
                                  {grpOutput.enclosures.map((entry, i) => {
                                    const entryChannels = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                                    const signalType = entryChannels === 1
                                      ? entry.enclosure.signal_channels.join("+")
                                      : entry.enclosure.signal_channels[posInGroup];
                                    const channelName = entryChannels > 1
                                      ? entry.enclosure.signal_channel_names?.[signalType]
                                      : undefined;
                                    return (
                                      <div key={i}>
                                        {isSecondary ? (
                                          <div className="text-sm italic text-gray-400 dark:text-neutral-600">Channel allocated</div>
                                        ) : (
                                          <div className="text-sm text-gray-900 dark:text-gray-200">
                                            {entry.count}x {entry.enclosure.enclosure}
                                          </div>
                                        )}
                                        {channelName && (
                                          <div className="text-[10px] text-gray-400 dark:text-neutral-500">
                                            {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                                          </div>
                                        )}
                                        <div
                                          className="text-[10px] font-medium"
                                          style={getSignalTypeGoldStyle(posInGroup, channelsPerUnit)}
                                        >
                                          {signalType}
                                        </div>
                                      </div>
                                    );
                                  })}
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
                            {onCableLengthChange && ampId && (
                              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                                <CableLengthInput lengthMeters={cableLengths?.[`${ampId}:${groupOutputs[0].outputIndex}`] ?? 0} onChange={(m) => onCableLengthChange(groupOutputs[0].outputIndex, m)} useFeet={useFeet} outputIndex={groupOutputs[0].outputIndex} />
                                <CableLossDisplay impedanceOhms={groupOutputs[0].impedanceOhms} cableLengthMeters={cableLengths?.[`${ampId}:${groupOutputs[0].outputIndex}`] ?? 0} gaugeMm2={cableGaugeMm2} />
                              </div>
                            )}
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
                        const oIsMultiChannel = o.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
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
                                <div className={`border-t my-1 ${hasChannelError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />
                                {hasLoad ? (
                                  <>
                                    <div className="flex-1">
                                      {grpOutput.enclosures.map((entry, i) => {
                                        const entryChannels = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                                        return (
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
                                              {entryChannels === 1
                                                ? entry.enclosure.signal_channels.join("+")
                                                : entry.enclosure.signal_channels[grpOutput.outputIndex % entry.enclosure.signal_channels.length]}
                                            </div>
                                          </div>
                                        );
                                      })}
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
                                  /* Empty channel - show routing selector for preparation */
                                  <>
                                    <div className="flex-1" />
                                    <div className="flex items-end justify-between pt-0.5 text-[10px]">
                                      {onRoutingChange ? (
                                        <RoutingSelector value={routingMap?.[grpOutput.outputIndex] ?? "A"} onChange={(value) => onRoutingChange(grpOutput.outputIndex, value)} />
                                      ) : <span />}
                                      <span />
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {/* Cable length on its own line at the bottom for combined card */}
                        {firstWithLoad && firstWithLoad.impedanceOhms !== Infinity && firstWithLoad.impedanceOhms > 0 && (
                          <div className="pt-1 text-[10px]">
                            {onCableLengthChange && ampId && (
                              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                                <CableLengthInput lengthMeters={cableLengths?.[`${ampId}:${firstWithLoad.outputIndex}`] ?? 0} onChange={(m) => onCableLengthChange(firstWithLoad.outputIndex, m)} useFeet={useFeet} outputIndex={firstWithLoad.outputIndex} />
                                <CableLossDisplay impedanceOhms={firstWithLoad.impedanceOhms} cableLengthMeters={cableLengths?.[`${ampId}:${firstWithLoad.outputIndex}`] ?? 0} gaugeMm2={cableGaugeMm2} />
                              </div>
                            )}
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
                      <img src={imageUrl} alt={entry.enclosure.enclosure} className="h-12 w-20 object-contain" />
                    )}
                    <span>{entry.count}x {entry.enclosure.enclosure}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        /* Empty physical output - still show channel numbers and routing selectors */
        <div className="border-t border-gray-200 dark:border-neutral-700">
          <div className={`flex-1 ${outputs.length > 1 ? "grid gap-2" : ""}`} style={outputs.length > 1 ? { gridTemplateColumns: `repeat(${outputs.length}, 1fr)` } : undefined}>
            {outputs.map((output, idx) => (
              <div
                key={output.outputIndex}
                className={`flex flex-col pt-1 ${idx > 0 ? "border-l border-gray-200 dark:border-neutral-700 pl-2" : ""}`}
              >
                <div className="font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                  Ch {output.outputIndex + 1}
                </div>
                <div className="border-t my-1 border-gray-200/60 dark:border-neutral-700" />
                <div className="flex-1" />
                <div className="flex items-end justify-between pt-0.5 text-[10px]">
                  {onRoutingChange ? (
                    <RoutingSelector value={routingMap?.[output.outputIndex] ?? "A"} onChange={(value) => onRoutingChange(output.outputIndex, value)} />
                  ) : <span />}
                  <span />
                </div>
              </div>
            ))}
          </div>
        </div>
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
  // For multi-channel enclosures, only count on primary channel to avoid double-counting
  const enclosureTotals = new Map<string, number>();
  for (const instance of instances) {
    const seenMultiChannel = new Set<string>();
    for (const output of instance.outputs) {
      for (const entry of output.enclosures) {
        const name = entry.enclosure.enclosure;
        const channelsPerUnit = getChannelsPerUnit(entry.enclosure, instance.ampConfig.key);

        if (channelsPerUnit > 1) {
          // Multi-channel enclosure: only count on primary channel (to avoid double-counting)
          const groupIdx = Math.floor(output.outputIndex / channelsPerUnit);
          const groupKey = `${name}_${groupIdx}`;
          if (seenMultiChannel.has(groupKey)) continue;
          seenMultiChannel.add(groupKey);
        }

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
                    <img src={imageUrl} alt={name} className="h-12 w-20 object-contain" />
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

/** Sales mode card for LA-RAK: shows rack count instead of individual LA12X count */
function GroupedRackCard({ rackCount, la12xInstances }: { rackCount: number; la12xInstances: AmpInstance[] }) {
  // Aggregate enclosures across all LA12X instances
  const enclosureTotals = new Map<string, number>();
  for (const instance of la12xInstances) {
    const seenMultiChannel = new Set<string>();
    for (const output of instance.outputs) {
      for (const entry of output.enclosures) {
        const name = entry.enclosure.enclosure;
        const channelsPerUnit = getChannelsPerUnit(entry.enclosure, instance.ampConfig.key);
        if (channelsPerUnit > 1) {
          const groupIdx = Math.floor(output.outputIndex / channelsPerUnit);
          const groupKey = `${name}_${groupIdx}`;
          if (seenMultiChannel.has(groupKey)) continue;
          seenMultiChannel.add(groupKey);
        }
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
              LA-RAK
            </span>
            <span className="ml-1 text-xs text-gray-500 dark:text-neutral-500">
              (3x LA12X)
            </span>
            <span className="ml-2 text-sm font-medium text-gray-700 dark:text-neutral-400">
              ({rackCount})
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
                    <img src={imageUrl} alt={name} className="h-12 w-20 object-contain" />
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

/** LA-RAK card: groups up to 3 LA12X amps into a rack frame */
function LaRakCard({ rackIndex, instances, cableGaugeMm2, useFeet, onAdjustEnclosure, packedMap, spreadMap, onTogglePacked, onToggleSpread, lockedAmpIds, onLockAmpInstance, onUnlockAmpInstance, globalIndices, canCombineWithOthers = false, onCombineRacks, cableLengths, onCableLengthChange }: { rackIndex: number; instances: AmpInstance[]; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packedMap: Record<number, boolean>; spreadMap: Record<number, boolean>; onTogglePacked: (index: number) => void; onToggleSpread: (index: number) => void; lockedAmpIds?: Set<string>; onLockAmpInstance?: (ampInstance: AmpInstance) => void; onUnlockAmpInstance?: (ampInstanceId: string) => void; globalIndices: number[]; canCombineWithOthers?: boolean; onCombineRacks?: () => void; cableLengths?: Record<string, number>; onCableLengthChange?: (ampIndex: number, outputIndex: number, meters: number) => void }) {
  const RACK_SLOTS = 3;
  const emptySlots = RACK_SLOTS - instances.length;

  // Rack is locked when ALL real instances are locked
  const isRackLocked = instances.length > 0 && instances.every(
    (inst) => lockedAmpIds?.has(inst.id) ?? false
  );

  return (
    <div className={`rounded-lg border-2 p-3 ${
      isRackLocked
        ? "border-amber-400/60 dark:border-amber-600/40 bg-gray-50/50 dark:bg-neutral-950/50"
        : "border-gray-400 dark:border-neutral-500 bg-gray-50/50 dark:bg-neutral-950/50"
    }`}>
      {/* Rack Header */}
      <div className="mb-3 flex items-center gap-2">
        {/* Rack-level lock/unlock button */}
        {isRackLocked ? (
          <button
            onClick={() => {
              for (const inst of instances) {
                onUnlockAmpInstance?.(inst.id);
              }
            }}
            className="rounded p-1 transition-colors"
            style={{ backgroundColor: 'rgba(181, 158, 95, 0.2)', color: '#b59e5f' }}
            title="Unlock all amplifiers in this rack"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </button>
        ) : onLockAmpInstance && (
          <button
            onClick={() => {
              // Generate a unique rackGroupId for all amps locked together
              const rackGroupId = `rack-${crypto.randomUUID().split("-").pop()}`;
              for (const inst of instances) {
                if (!(lockedAmpIds?.has(inst.id))) {
                  // Attach rackGroupId so they stay together when locked
                  onLockAmpInstance?.({ ...inst, rackGroupId });
                }
              }
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-300 transition-colors"
            title="Lock all amplifiers in this rack"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          </button>
        )}
        <span className="text-sm font-bold tracking-wider text-gray-700 dark:text-neutral-300">
          LA-RAK #{rackIndex + 1}
        </span>
        <span className="text-xs text-gray-500 dark:text-neutral-500">
          {instances.length}/{RACK_SLOTS} Amps in use
        </span>
        {/* Green button when this locked rack can be combined with others */}
        {canCombineWithOthers && isRackLocked && onCombineRacks && (
          <button
            onClick={onCombineRacks}
            className="ml-auto flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-400 dark:hover:bg-green-900/60 transition-colors"
            title="Combine all locked LA-RAK units into one"
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
            </svg>
            <span>Combine</span>
          </button>
        )}
      </div>

      {isRackLocked ? (
        /* Condensed locked view - per-channel enclosure details */
        <div className="space-y-1.5">
          {instances.map((instance) => {
            const ampOutputCount = instance.ampConfig.outputs;
            return (
              <div
                key={instance.id}
                className="rounded border border-gray-200 bg-white/80 dark:border-neutral-700 dark:bg-neutral-800/80"
              >
                {/* Compact header row */}
                <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-neutral-700">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-gray-900 dark:text-gray-200">
                      {instance.ampConfig.model}
                    </span>
                    {instance.ampConfig.mode && (
                      <span className="rounded bg-blue-100 px-1 py-0.5 text-[8px] font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300">
                        {instance.ampConfig.mode}
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] font-medium ${getLoadColor(instance.loadPercent)}`}>
                    {instance.loadPercent}%
                  </span>
                </div>
                {/* Output indicators row */}
                {(() => {
                  const physicalOutputCount = instance.ampConfig.physicalOutputs;
                  return (
                    <div className="grid gap-px px-1 pt-1" style={{ gridTemplateColumns: `repeat(${physicalOutputCount}, 1fr)` }}>
                      {Array.from({ length: physicalOutputCount }).map((_, outputIdx) => (
                        <div key={outputIdx} className="text-center">
                          <span className="text-[8px] font-medium" style={getOutputTealStyle(outputIdx, physicalOutputCount)}>
                            Output {outputIdx + 1}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Channel grid */}
                <div className="grid gap-px px-1 py-1" style={{ gridTemplateColumns: `repeat(${ampOutputCount}, 1fr)` }}>
                  {instance.outputs.map((output) => {
                    const hasLoad = output.totalEnclosures > 0;
                    return (
                      <div key={output.outputIndex} className="px-1 text-center">
                        <div className="text-[9px] font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                          Ch {output.outputIndex + 1}
                        </div>
                        {hasLoad ? (
                          <div className="text-[9px] leading-tight">
                            {output.enclosures.map((entry, i) => {
                              const channelsPerUnit = getChannelsPerUnit(entry.enclosure, instance.ampConfig.key);
                              const posInGroup = output.outputIndex % channelsPerUnit;
                              const isPrimary = posInGroup === 0;
                              const signalLabel = channelsPerUnit === 1
                                ? entry.enclosure.signal_channels.join("+")
                                : entry.enclosure.signal_channels[posInGroup];
                              const channelName = channelsPerUnit > 1
                                ? entry.enclosure.signal_channel_names?.[entry.enclosure.signal_channels[posInGroup]]
                                : undefined;
                              return (
                                <div key={i}>
                                  {isPrimary || channelsPerUnit === 1 ? (
                                    <div className="text-gray-700 dark:text-gray-300">
                                      {entry.count}x {entry.enclosure.enclosure}
                                    </div>
                                  ) : (
                                    <div className="text-[7px] italic text-gray-400 dark:text-neutral-600">Allocated to</div>
                                  )}
                                  {channelName && (
                                    <div className="text-[7px] text-gray-400 dark:text-neutral-500">
                                      {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                                    </div>
                                  )}
                                  <div className="text-[8px] font-medium" style={getSignalTypeGoldStyle(posInGroup, channelsPerUnit)}>
                                    {signalLabel}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-[9px] text-gray-300 dark:text-neutral-600">—</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Expanded view with full AmpCards */
        <div className="space-y-3">
          {instances.map((instance, localIdx) => {
            const globalIdx = globalIndices[localIdx];
            const packed = packedMap[globalIdx] ?? false;
            const spread = spreadMap[globalIdx] ?? false;

            return (
              <AmpCard
                key={instance.id}
                instance={instance}
                salesMode={false}
                cableGaugeMm2={cableGaugeMm2}
                useFeet={useFeet}
                onAdjustEnclosure={onAdjustEnclosure}
                packed={packed}
                spread={spread}
                onTogglePacked={() => onTogglePacked(globalIdx)}
                onToggleSpread={() => onToggleSpread(globalIdx)}
                ampIndex={globalIdx}
                cableLengths={cableLengths}
                onCableLengthChange={(outputIndex, meters) => onCableLengthChange?.(globalIdx, outputIndex, meters)}
              />
            );
          })}

          {/* Empty rack slots - render as empty LA12X amps */}
          {Array.from({ length: emptySlots }).map((_, i) => {
            const ampConfig = instances[0].ampConfig;
            const emptyInstance: AmpInstance = {
              id: `rack-${rackIndex}-empty-${i}`,
              ampConfig,
              outputs: Array.from({ length: ampConfig.outputs }, (_, oi) => ({
                outputIndex: oi,
                enclosures: [],
                totalEnclosures: 0,
                impedanceOhms: Infinity,
              })),
              totalEnclosures: 0,
              loadPercent: 0,
            };
            return (
              <AmpCard
                key={`empty-${i}`}
                instance={emptyInstance}
                salesMode={false}
                cableGaugeMm2={cableGaugeMm2}
                useFeet={useFeet}
                packed={false}
                spread={false}
                onTogglePacked={() => {}}
                onToggleSpread={() => {}}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function AmpCard({ instance: rawInstance, salesMode = false, cableGaugeMm2, useFeet, onAdjustEnclosure, packed, spread, onTogglePacked, onToggleSpread, isLocked = false, onLock, onUnlock, ampNumber, ampIndex, cableLengths, onCableLengthChange }: { instance: AmpInstance; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packed: boolean; spread: boolean; onTogglePacked: () => void; onToggleSpread: () => void; isLocked?: boolean; onLock?: () => void; onUnlock?: () => void; ampNumber?: number; ampIndex?: number; cableLengths?: Record<string, number>; onCableLengthChange?: (outputIndex: number, lengthMeters: number) => void }) {

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

  // Stable key prefix for cable lengths — uses positional index when available
  const cableKeyPrefix = ampIndex !== undefined ? String(ampIndex) : instance.id;

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
  const inputLettersMap = useMemo(() => instance.outputs.map((_, i) => getInputLetter(instance.outputs, i, instance.ampConfig.key)), [instance.outputs, instance.ampConfig.key]);

  // Input routing state per channel (default: same letter for multi-channel enclosures)
  const [routingMap, setRoutingMap] = useState<Record<number, RoutingOption>>(() => {
    const initial: Record<number, RoutingOption> = {};
    const letters: RoutingOption[] = ["A", "B", "C", "D"];
    let letterIndex = 0;
    let i = 0;

    while (i < instance.outputs.length) {
      const output = instance.outputs[i];
      const hasLoad = output.totalEnclosures > 0;

      if (!hasLoad) {
        // Empty channel gets the current letter
        initial[output.outputIndex] = letters[letterIndex % 4];
        i++;
        continue;
      }

      // Check if this is a multi-channel enclosure
      const channelsPerUnit = getChannelsPerUnit(output.enclosures[0]?.enclosure, instance.ampConfig.key);

      if (channelsPerUnit > 1) {
        // Multi-channel enclosure: assign same letter to all its channels
        const currentLetter = letters[letterIndex % 4];
        for (let j = 0; j < channelsPerUnit && i + j < instance.outputs.length; j++) {
          initial[instance.outputs[i + j].outputIndex] = currentLetter;
        }
        i += channelsPerUnit;
        letterIndex++;
      } else {
        // Single-channel enclosure
        initial[output.outputIndex] = letters[letterIndex % 4];
        i++;
        letterIndex++;
      }
    }

    return initial;
  });

  // Handler to update routing for a specific channel (independent per channel)
  const handleRoutingChange = (channelIndex: number, value: RoutingOption) => {
    setRoutingMap(prev => ({ ...prev, [channelIndex]: value }));
  };

  // Check if any output has impedance at or above max rated (for annotation legend)
  // Skip multi-channel enclosure outputs — their per-section impedance is fixed by speaker design
  const maxRated = instance.ampConfig.ratedImpedances.length > 0 ? Math.max(...instance.ampConfig.ratedImpedances) : Infinity;
  const hasAboveRatedOutput = instance.outputs.some(
    (o) => o.totalEnclosures > 0 && o.impedanceOhms !== Infinity && o.impedanceOhms > maxRated
      && !o.enclosures.some(e => getChannelsPerUnit(e.enclosure, instance.ampConfig.key) > 1)
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

    // Check if it's a multi-channel enclosure that actually spans all channels
    // (e.g., K2 has 4 signal_channels and fills all 4 outputs of LA12X)
    // This prevents 2 Kara IIs (2 channels each) from being treated as a single spanning enclosure
    const channelsPerUnit = getChannelsPerUnit(firstEnclosure, instance.ampConfig.key);
    if (channelsPerUnit < 2) return null;
    if (channelsPerUnit < ampOutputCount) return null; // Must span ALL channels, not just fill them with multiple units

    return firstEnclosure;
  }, [usePhysicalGrouping, instance.outputs, ampOutputCount, instance.ampConfig.key]);

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
              {instance.ampConfig.model}{ampNumber !== undefined && ` #${ampNumber}`}
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
                  ampConfigKey={instance.ampConfig.key}
                  cableLengths={cableLengths}
                  ampId={ampIndex !== undefined ? String(ampIndex) : instance.id}
                  onCableLengthChange={(outputIndex, meters) => onCableLengthChange?.(outputIndex, meters)}
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
                ampConfigKey={instance.ampConfig.key}
                cableLengthMeters={cableLengths?.[`${cableKeyPrefix}:${instance.outputs[0].outputIndex}`] ?? 0}
                onCableLengthChange={(meters) => onCableLengthChange?.(instance.outputs[0].outputIndex, meters)}
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

                  const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, instance.ampConfig.key) > 1);
                  const channelsPerUnit = getChannelsPerUnit(output.enclosures[0]?.enclosure, instance.ampConfig.key);

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
                        ampConfigKey={instance.ampConfig.key}
                        cableLengthMeters={cableLengths?.[`${cableKeyPrefix}:${groupOutputs[0].outputIndex}`] ?? 0}
                        onCableLengthChange={(meters) => onCableLengthChange?.(groupOutputs[0].outputIndex, meters)}
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
                        ampConfigKey={instance.ampConfig.key}
                        ampId={instance.id}
                        ampModel={instance.ampConfig.model}
                        isLocked={isLocked}
                        cableLengthMeters={cableLengths?.[`${cableKeyPrefix}:${output.outputIndex}`] ?? 0}
                        onCableLengthChange={(meters) => onCableLengthChange?.(output.outputIndex, meters)}
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
          {/* Cable loss frequency chart — shows when any output has a cable length */}
          {(() => {
            const chartOutputs = instance.outputs
              .filter(o => o.totalEnclosures > 0)
              .map(o => ({
                outputIndex: o.outputIndex,
                enclosureName: o.enclosures[0]?.enclosure.enclosure ?? "",
                nominalImpedance: o.enclosures[0]?.enclosure.nominal_impedance_ohms ?? 8,
                signalChannels: o.enclosures[0]?.enclosure.signal_channels ?? [],
                cableLengthMeters: cableLengths?.[`${cableKeyPrefix}:${o.outputIndex}`] ?? 0,
                impedanceOhms: o.impedanceOhms,
              }));
            return chartOutputs.some(o => o.cableLengthMeters > 0) ? (
              <CableLossChart outputs={chartOutputs} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

/** Renders a single zone's solver results */
function ZoneSolutionSection({ solution, salesMode, rackMode, cableGaugeMm2, useFeet, onAdjustEnclosure, lockedAmpIds, onLockAmpInstance, onUnlockAmpInstance, onCombineLockedRacks }: { solution: SolverSolution; salesMode: boolean; rackMode: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; lockedAmpIds?: Set<string>; onLockAmpInstance?: (ampInstance: AmpInstance) => void; onUnlockAmpInstance?: (ampInstanceId: string) => void; onCombineLockedRacks?: (ampIds: string[]) => void }) {
  // Track packed/spread state per amp index (independent per amp)
  const [packedMap, setPackedMap] = useState<Record<number, boolean>>({});
  const [spreadMap, setSpreadMap] = useState<Record<number, boolean>>({});

  // Per-output cable length in meters, keyed by "ampIndex:outputIndex"
  // Uses positional index (not volatile UUID) so values survive solver re-runs
  const [cableLengths, setCableLengths] = useState<Record<string, number>>({});
  const handleCableLengthChange = (ampIndex: number, outputIndex: number, meters: number) => {
    setCableLengths(prev => ({ ...prev, [`${ampIndex}:${outputIndex}`]: meters }));
  };

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

  const handleTogglePacked = (index: number) => {
    setPackedMap(prev => {
      const wasPacked = prev[index] ?? false;
      if (wasPacked) {
        setSpreadMap(s => ({ ...s, [index]: false }));
      }
      return { ...prev, [index]: !wasPacked };
    });
  };

  const handleToggleSpread = (index: number) => {
    setSpreadMap(prev => ({ ...prev, [index]: !(prev[index] ?? false) }));
  };

  // Track lock transitions for animation
  const prevLockedRef = useRef<Set<string>>(new Set());
  const [animatingLockIds, setAnimatingLockIds] = useState<Set<string>>(new Set());
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Detect newly locked amps and trigger slide-up animation
  useEffect(() => {
    const curr = lockedAmpIds ?? new Set<string>();
    const prev = prevLockedRef.current;

    const newlyLocked = new Set<string>();
    for (const id of curr) {
      if (!prev.has(id)) newlyLocked.add(id);
    }

    prevLockedRef.current = new Set(curr);

    if (newlyLocked.size > 0) {
      setAnimatingLockIds(newlyLocked);
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => setAnimatingLockIds(new Set()), 500);
    }

    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
    };
  }, [lockedAmpIds]);

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

            // When rack mode is on, replace LA12X group with LA-RAK count
            if (rackMode && grouped.has("LA12X")) {
              const la12xInstances = grouped.get("LA12X")!;
              const rackCount = Math.ceil(la12xInstances.length / 3);
              grouped.delete("LA12X");

              return (
                <>
                  <GroupedRackCard rackCount={rackCount} la12xInstances={la12xInstances} />
                  {Array.from(grouped.entries()).map(([key, instances]) => (
                    <GroupedAmpCard key={key} instances={instances} />
                  ))}
                </>
              );
            }

            return Array.from(grouped.entries()).map(([key, instances]) => (
              <GroupedAmpCard key={key} instances={instances} />
            ));
          })()
        ) : rackMode ? (
          (() => {
            // Partition into LA12X and other amps, tracking global indices
            const la12xEntries: { instance: AmpInstance; globalIndex: number }[] = [];
            const otherEntries: { instance: AmpInstance; globalIndex: number }[] = [];
            solution.ampInstances.forEach((instance, index) => {
              if (instance.ampConfig.key === "LA12X") {
                la12xEntries.push({ instance, globalIndex: index });
              } else {
                otherEntries.push({ instance, globalIndex: index });
              }
            });

            const RACK_SIZE = 3;

            // Separate locked and unlocked LA12X BEFORE grouping into racks
            // This prevents locked amps from being mixed with new solver results
            const lockedLa12x = la12xEntries.filter(e => lockedAmpIds?.has(e.instance.id));
            const unlockedLa12x = la12xEntries.filter(e => !(lockedAmpIds?.has(e.instance.id)));

            // Group locked LA12X by their rackGroupId (amps locked together stay together)
            // Amps without a rackGroupId get their own individual rack
            const lockedRackGroups = new Map<string, { instance: AmpInstance; globalIndex: number }[]>();
            for (const entry of lockedLa12x) {
              const groupId = entry.instance.rackGroupId ?? entry.instance.id; // fallback to amp id if no group
              if (!lockedRackGroups.has(groupId)) {
                lockedRackGroups.set(groupId, []);
              }
              lockedRackGroups.get(groupId)!.push(entry);
            }
            const lockedRacks = Array.from(lockedRackGroups.values());

            // Check if combining locked racks is possible (more than 1 locked rack, total <= RACK_SIZE)
            const canCombineLockedRacks = lockedRacks.length > 1 && lockedLa12x.length <= RACK_SIZE;

            // Group unlocked LA12X into their own racks
            const unlockedRacks: { instance: AmpInstance; globalIndex: number }[][] = [];
            for (let r = 0; r < Math.ceil(unlockedLa12x.length / RACK_SIZE); r++) {
              unlockedRacks.push(unlockedLa12x.slice(r * RACK_SIZE, (r + 1) * RACK_SIZE));
            }

            // Separate locked and unlocked other amps
            const lockedOther = otherEntries.filter(e => lockedAmpIds?.has(e.instance.id));
            const unlockedOther = otherEntries.filter(e => !(lockedAmpIds?.has(e.instance.id)));

            const hasLocked = lockedRacks.length > 0 || lockedOther.length > 0;

            return (
              <>
                {/* Locked items at top, side by side */}
                {hasLocked && (
                  <div className="flex flex-wrap gap-4 items-start">
                    {lockedRacks.map((rackEntries, rackIdx) => {
                      const isAnimating = rackEntries.some(e => animatingLockIds.has(e.instance.id));
                      return (
                      <div key={`locked-rack-${rackIdx}`} className={`w-[calc(50%-0.5rem)] ${isAnimating ? 'lock-slide-up' : ''}`}>
                        <LaRakCard
                          rackIndex={rackIdx}
                          instances={rackEntries.map(e => e.instance)}
                          cableGaugeMm2={cableGaugeMm2}
                          useFeet={useFeet}
                          onAdjustEnclosure={onAdjustEnclosure}
                          packedMap={packedMap}
                          spreadMap={spreadMap}
                          onTogglePacked={handleTogglePacked}
                          onToggleSpread={handleToggleSpread}
                          lockedAmpIds={lockedAmpIds}
                          onLockAmpInstance={onLockAmpInstance}
                          onUnlockAmpInstance={onUnlockAmpInstance}
                          globalIndices={rackEntries.map(e => e.globalIndex)}
                          canCombineWithOthers={canCombineLockedRacks}
                          onCombineRacks={() => {
                            // Combine all locked LA12X amps into one rack
                            const allLockedLa12xIds = lockedLa12x.map(e => e.instance.id);
                            onCombineLockedRacks?.(allLockedLa12xIds);
                          }}
                          cableLengths={cableLengths}
                          onCableLengthChange={handleCableLengthChange}
                        />
                      </div>
                      );
                    })}
                    {lockedOther.map(({ instance, globalIndex }, idx) => (
                      <div key={instance.id} className={`w-[calc(50%-0.5rem)] ${animatingLockIds.has(instance.id) ? 'lock-slide-up' : ''}`}>
                        <AmpCard
                          instance={instance}
                          salesMode={false}
                          cableGaugeMm2={cableGaugeMm2}
                          useFeet={useFeet}
                          onAdjustEnclosure={onAdjustEnclosure}
                          packed={packedMap[globalIndex] ?? false}
                          spread={spreadMap[globalIndex] ?? false}
                          onTogglePacked={() => handleTogglePacked(globalIndex)}
                          onToggleSpread={() => handleToggleSpread(globalIndex)}
                          isLocked={true}
                          onLock={() => onLockAmpInstance?.(instance)}
                          onUnlock={() => onUnlockAmpInstance?.(instance.id)}
                          ampNumber={idx + 1}
                          ampIndex={globalIndex}
                          cableLengths={cableLengths}
                          onCableLengthChange={(outputIndex, meters) => handleCableLengthChange(globalIndex, outputIndex, meters)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {/* Unlocked items below, full width */}
                {unlockedRacks.map((rackEntries, rackIdx) => (
                  <LaRakCard
                    key={`rack-${rackIdx}`}
                    rackIndex={lockedRacks.length + rackIdx}
                    instances={rackEntries.map(e => e.instance)}
                    cableGaugeMm2={cableGaugeMm2}
                    useFeet={useFeet}
                    onAdjustEnclosure={onAdjustEnclosure}
                    packedMap={packedMap}
                    spreadMap={spreadMap}
                    onTogglePacked={handleTogglePacked}
                    onToggleSpread={handleToggleSpread}
                    lockedAmpIds={lockedAmpIds}
                    onLockAmpInstance={onLockAmpInstance}
                    onUnlockAmpInstance={onUnlockAmpInstance}
                    globalIndices={rackEntries.map(e => e.globalIndex)}
                    cableLengths={cableLengths}
                    onCableLengthChange={handleCableLengthChange}
                  />
                ))}
                {unlockedOther.map(({ instance, globalIndex }, idx) => (
                  <AmpCard
                    key={instance.id}
                    instance={instance}
                    salesMode={false}
                    cableGaugeMm2={cableGaugeMm2}
                    useFeet={useFeet}
                    onAdjustEnclosure={onAdjustEnclosure}
                    packed={packedMap[globalIndex] ?? false}
                    spread={spreadMap[globalIndex] ?? false}
                    onTogglePacked={() => handleTogglePacked(globalIndex)}
                    onToggleSpread={() => handleToggleSpread(globalIndex)}
                    isLocked={false}
                    onLock={() => onLockAmpInstance?.(instance)}
                    onUnlock={() => onUnlockAmpInstance?.(instance.id)}
                    ampNumber={lockedOther.length + idx + 1}
                    ampIndex={globalIndex}
                    cableLengths={cableLengths}
                    onCableLengthChange={(outputIndex, meters) => handleCableLengthChange(globalIndex, outputIndex, meters)}
                  />
                ))}
              </>
            );
          })()
        ) : (
          (() => {
            // Sort locked amps to the top, unlocked below — all full width
            const entries = solution.ampInstances.map((instance, index) => ({ instance, index }));
            const locked = entries.filter(e => lockedAmpIds?.has(e.instance.id));
            const unlocked = entries.filter(e => !(lockedAmpIds?.has(e.instance.id)));
            const sorted = [...locked, ...unlocked];

            return sorted.map(({ instance, index }, displayIndex) => (
              <AmpCard
                key={instance.id}
                instance={instance}
                salesMode={salesMode}
                cableGaugeMm2={cableGaugeMm2}
                useFeet={useFeet}
                onAdjustEnclosure={onAdjustEnclosure}
                packed={packedMap[index] ?? false}
                spread={spreadMap[index] ?? false}
                onTogglePacked={() => handleTogglePacked(index)}
                onToggleSpread={() => handleToggleSpread(index)}
                isLocked={lockedAmpIds?.has(instance.id) ?? false}
                onLock={() => onLockAmpInstance?.(instance)}
                onUnlock={() => onUnlockAmpInstance?.(instance.id)}
                ampNumber={displayIndex + 1}
                ampIndex={index}
                cableLengths={cableLengths}
                onCableLengthChange={(outputIndex, meters) => handleCableLengthChange(index, outputIndex, meters)}
              />
            ));
          })()
        )}
      </div>
    </div>
  );
}

export default function SolverResults({ zoneSolutions, activeZoneId, salesMode = false, rackMode = false, cableGaugeMm2 = 2.5, useFeet = true, onAdjustEnclosure, onLockAmpInstance, onUnlockAmpInstance, onCombineLockedRacks, onMoveEnclosure }: SolverResultsProps) {
  // Find the active zone's solution
  const activeZoneSolution = zoneSolutions.find((zs) => zs.zone.id === activeZoneId);
  const activeSolution = activeZoneSolution?.solution ?? null;

  // Validation function for drag-drop
  const validateDrop = (
    _source: DraggableEnclosureData,
    _target: DroppableChannelData
  ): DropValidation => {
    // Only locked amps can have enclosures moved - no confirmation needed
    // Future: check enclosure compatibility with target amp
    return {
      isValid: true,
      requiresConfirmation: false,
    };
  };

  // Handle the actual move
  const handleMoveEnclosure = (result: EnclosureMoveResult) => {
    onMoveEnclosure?.(result);
  };

  if (!activeSolution) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-neutral-700 dark:text-neutral-500">
        <p>Add enclosures to see amplifier recommendations.</p>
      </div>
    );
  }

  return (
    <EnclosureDragDropProvider
      onMoveEnclosure={handleMoveEnclosure}
      validateDrop={validateDrop}
    >
      <div className="space-y-6">
        {/* Active Zone Results */}
        <ZoneSolutionSection
          solution={activeSolution}
          salesMode={salesMode}
          rackMode={rackMode}
          cableGaugeMm2={cableGaugeMm2}
          useFeet={useFeet}
          onAdjustEnclosure={onAdjustEnclosure}
          lockedAmpIds={new Set(activeZoneSolution?.zone.lockedAmpInstances.map(a => a.id) ?? [])}
          onLockAmpInstance={onLockAmpInstance}
          onUnlockAmpInstance={onUnlockAmpInstance}
          onCombineLockedRacks={onCombineLockedRacks}
        />
      </div>
    </EnclosureDragDropProvider>
  );
}
