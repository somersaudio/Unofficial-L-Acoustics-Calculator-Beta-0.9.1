import React, { useState, useMemo, useEffect, useRef } from "react"; // eslint-disable-line
import type { AmpInstance, OutputAllocation, ZoneWithSolution, SolverSolution } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS, getMaxCableLength } from "../types";
import { getImpedanceErrors, repackAmpInstance, spreadAmpInstance } from "../solver/ampSolver";
import { generatePDFReport } from "../utils/pdfExport";
import { getEnclosureImage } from "../utils/enclosureImages";

interface SolverResultsProps {
  zoneSolutions: ZoneWithSolution[];
  activeZoneId: string;
  salesMode?: boolean;
  cableGaugeMm2?: number;
  useFeet?: boolean;
  onAdjustEnclosure?: (enclosureName: string, delta: number) => void;
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

function getLoadColor(loadPercent: number): string {
  if (loadPercent > 100) return "text-red-600 dark:text-red-500";
  if (loadPercent > 80) return "text-amber-600 dark:text-amber-500";
  return "text-green-600 dark:text-green-500";
}

const MAX_ENCLOSURE_TYPES_PER_AMP = 3;

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

/** Build a map of enclosure name -> type index (0, 1, 2) for coloring */
function buildEnclosureTypeMap(instance: AmpInstance): Map<string, number> {
  const typeMap = new Map<string, number>();
  let index = 0;
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      const name = entry.enclosure.enclosure;
      if (!typeMap.has(name) && index < MAX_ENCLOSURE_TYPES_PER_AMP) {
        typeMap.set(name, index++);
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

function OutputCard({ output, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, isSecondaryChannel = false, hideEnclosureName = false, enclosureTypeMap }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; isSecondaryChannel?: boolean; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number> }) {
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

  // Get the signal channel label for this output (for multi-channel enclosures)
  const signalLabel = hasLoad && output.enclosures[0]?.enclosure.signal_channels?.length > 1
    ? output.enclosures[0].enclosure.signal_channels[output.outputIndex % output.enclosures[0].enclosure.signal_channels.length]
    : null;

  // Secondary channel: shaded appearance, show grayed-out enclosure name and signal type
  // Match primary card structure for vertical alignment
  if (isSecondaryChannel && hasLoad) {
    return (
      <div
        className={`flex flex-col rounded border ${is16Channel ? "p-1 text-[10px]" : "p-2 text-xs"} ${
          hasImpedanceError
            ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
            : "border-blue-200/60 bg-blue-100/40 dark:border-neutral-700 dark:bg-neutral-800/60"
        }`}
        style={!hasImpedanceError ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : undefined}
      >
        {/* Invisible header spacer to match primary card's "Output N NL4" header height */}
        {!is16Channel && (
          <div className="mb-1 font-medium invisible" aria-hidden="true">X</div>
        )}
        {!salesMode ? (
          <div className="flex-1 flex flex-col">
            {/* Channel header - matches primary's pt-1 font-medium */}
            {!is16Channel && (
              <div className="pt-1 font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                Ch {output.outputIndex + 1}
              </div>
            )}
            {is16Channel && (
              <div className="font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                Ch {output.outputIndex + 1}
              </div>
            )}
            <div className="flex-1">
              {/* Show grayed-out enclosure name and signal type */}
              {output.enclosures.map((entry, i) => (
                <div key={i}>
                  <div className="text-gray-400 dark:text-neutral-600">
                    {entry.count}x {entry.enclosure.enclosure}
                  </div>
                  <div className="text-[10px] text-gray-400 dark:text-neutral-600">
                    {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                  </div>
                </div>
              ))}
            </div>
            {/* Bottom row - matches primary's text-[10px] */}
            {!is16Channel && (
              <div className="flex items-end justify-end pt-0.5 text-[10px]">
                <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                  {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                </span>
              </div>
            )}
            {is16Channel && (
              <div className="flex items-center justify-end pt-0.5">
                <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                  {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col rounded border ${is16Channel ? "p-1 text-[10px]" : "p-2 text-xs"} ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
      style={cardTypeBg && !hasImpedanceError ? { backgroundColor: cardTypeBg } : undefined}
    >
      <div
        className={`${is16Channel ? "" : "mb-1"} font-medium ${is16Channel ? "" : "text-gray-700 dark:text-neutral-400"}`}
        style={is16Channel ? getChannelPurpleStyle(output.outputIndex, ampOutputCount) : undefined}
      >
        {outputLabel}
        {!is16Channel && (
          <span className="ml-1 text-[10px] font-normal text-gray-400 dark:text-neutral-500">NL4</span>
        )}
      </div>
      {hasLoad ? (
        <>
          {!salesMode && (
            <div className={`flex-1 flex flex-col border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
              {/* Only show "Ch N" label for non-16-channel amps (16ch already shows it as outputLabel above) */}
              {!is16Channel && (
                <div className="pt-1 font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                  Ch {output.outputIndex + 1}
                  {hasImpedanceError && (
                    <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                  )}
                </div>
              )}
              {is16Channel && hasImpedanceError && (
                <div className="pt-1 font-medium text-red-600 dark:text-red-500">ERROR</div>
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
                        <>
                          <div className="flex items-center gap-1 text-gray-900 dark:text-gray-200">
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
                          <div className="text-[10px] text-gray-500 dark:text-neutral-500">
                            {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                          </div>
                        </>
                      )}
                    </div>
                  ));
                })()}
              </div>
              {/* Bottom row: cable length at left, impedance at right */}
              {!is16Channel && (
                <div className="flex items-end justify-between pt-0.5 text-[10px]">
                  <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                  <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                    {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  </span>
                </div>
              )}
              {/* For 16-channel amps: show signal label and impedance */}
              {is16Channel && (
                <div className="flex items-center justify-between pt-0.5">
                  <span className="text-gray-400 dark:text-neutral-500">{signalLabel ?? ""}</span>
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
                <div key={i} className="text-gray-900 dark:text-gray-200">
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

/** Card for a physical output that groups multiple amp channels (e.g., LA12X NL4 carrying 2 channels) */
function PhysicalOutputCard({ outputs, physicalIndex, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, enclosureTypeMap }: { outputs: OutputAllocation[]; physicalIndex: number; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; enclosureTypeMap?: Map<string, number> }) {
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

  return (
    <div
      className={`rounded border p-2 text-xs ${
        hasImpedanceError
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
          : hasLoad
          ? allSecondary
            ? "border-blue-200/60 bg-blue-100/40 dark:border-neutral-700 dark:bg-neutral-800/60"
            : "border-blue-200 bg-blue-50 dark:border-neutral-600 dark:bg-neutral-800"
          : "border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
      style={allSecondary && !hasImpedanceError ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : undefined}
    >
      <div className={`mb-1 font-medium text-gray-700 dark:text-neutral-400 ${allSecondary ? "invisible" : ""}`}>
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
              {outputs.map((output) => {
                const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                const channelTypeBg = output.enclosures[0] && enclosureTypeMap
                  ? getEnclosureTypeBackground(output.enclosures[0].enclosure.enclosure, enclosureTypeMap)
                  : undefined;
                const hasChannelError = output.impedanceOhms < (output.minImpedanceOverride ?? HARD_FLOOR_IMPEDANCE) && output.impedanceOhms !== Infinity;
                const isMultiChannel = output.enclosures.some(e => e.enclosure.signal_channels.length > 1);
                const isSecondaryMultiChannel = isMultiChannel && output.enclosures[0] &&
                  (output.outputIndex % output.enclosures[0].enclosure.signal_channels.length) > 0;

                // Secondary multi-channel outputs: show grayed-out enclosure name and signal type
                // Structure matches primary channel for vertical alignment
                if (isSecondaryMultiChannel) {
                  return (
                    <div
                      key={output.outputIndex}
                      className={`flex flex-col rounded -mx-1 px-1 ${output.outputIndex > outputs[0].outputIndex ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
                      style={channelTypeBg && !hasChannelError ? { backgroundColor: channelTypeBg, backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' } : { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.03) 3px, rgba(0,0,0,0.03) 4px)' }}
                    >
                      <div className="font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                        Ch {output.outputIndex + 1}
                      </div>
                      {/* Show grayed-out enclosure name and signal type */}
                      <div className="flex-1">
                        {output.enclosures.map((entry, i) => (
                          <div key={i}>
                            <div className="text-gray-400 dark:text-neutral-600">
                              {entry.count}x {entry.enclosure.enclosure}
                            </div>
                            <div className="text-[10px] text-gray-400 dark:text-neutral-600">
                              {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Bottom row: cable length at left, impedance at right */}
                      <div className="flex items-end justify-between pt-0.5 text-[10px]">
                        {output.impedanceOhms !== Infinity && output.impedanceOhms > 0 ? (
                          <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                        ) : (
                          <span />
                        )}
                        <span className={hasChannelError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                          {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                        </span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={output.outputIndex}
                    className={`flex flex-col rounded -mx-1 px-1 ${output.outputIndex > outputs[0].outputIndex ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
                    style={channelTypeBg && !hasChannelError ? { backgroundColor: channelTypeBg } : undefined}
                  >
                    <div className="font-medium" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                      Ch {output.outputIndex + 1}
                      {hasChannelError && (
                        <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                      )}
                    </div>
                    <div className="flex-1">
                      {(() => {
                        const impedanceAboveRated = !isMultiChannel && output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                        return output.enclosures.map((entry, i) => (
                          <div key={i}>
                            <div className="flex items-center gap-1 text-gray-900 dark:text-gray-200">
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
                            <div className="text-[10px] text-gray-500 dark:text-neutral-500">
                              {entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                    {/* Bottom row: cable length at left, impedance at right */}
                    <div className="flex items-end justify-between pt-0.5 text-[10px]">
                      {output.impedanceOhms !== Infinity && output.impedanceOhms > 0 ? (
                        <CableLengthInfo impedanceOhms={output.impedanceOhms} gaugeMm2={cableGaugeMm2} useFeet={useFeet} />
                      ) : (
                        <span />
                      )}
                      <span className={hasChannelError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                        {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                      </span>
                    </div>
                  </div>
                );
              })}
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

function AmpCard({ instance: rawInstance, salesMode = false, cableGaugeMm2, useFeet, onAdjustEnclosure, packed, spread, onTogglePacked, onToggleSpread }: { instance: AmpInstance; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packed: boolean; spread: boolean; onTogglePacked: () => void; onToggleSpread: () => void }) {

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

  // Detect secondary channels of multi-channel enclosures
  const secondaryChannelSet = useMemo(() => {
    const set = new Set<number>();
    for (const output of instance.outputs) {
      for (const entry of output.enclosures) {
        const channelsPerUnit = entry.enclosure.signal_channels.length;
        if (channelsPerUnit > 1) {
          const posInGroup = output.outputIndex % channelsPerUnit;
          if (posInGroup > 0) {
            set.add(output.outputIndex);
          }
        }
      }
    }
    return set;
  }, [instance.outputs]);

  // Build enclosure type map for coloring
  const enclosureTypeMap = useMemo(() => buildEnclosureTypeMap(instance), [instance]);

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

  return (
    <div className={`rounded-lg border shadow-sm ${
      hasAnyImpedanceError ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30" : "border-gray-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    }`}>
      {/* Amp Header */}
      <div className={`border-b px-4 py-3 ${
        hasAnyImpedanceError ? "border-red-200 bg-red-100 dark:border-red-800 dark:bg-red-950/50" : "border-gray-200 bg-gray-100 dark:border-neutral-700 dark:bg-neutral-800"
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-900 dark:text-gray-200">
              {instance.ampConfig.model}
            </span>
            {instance.ampConfig.mode && (
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300">
                {instance.ampConfig.mode}
              </span>
            )}
            <span className="text-sm text-gray-500 dark:text-neutral-500">#{rawInstance.id.split("-").pop()}</span>
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
          {usePhysicalGrouping && physicalGroups ? (
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
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  ratedImpedances={instance.ampConfig.ratedImpedances}
                  onAdjustEnclosure={packed ? undefined : onAdjustEnclosure}
                  isSecondaryChannel={secondaryChannelSet.has(output.outputIndex)}
                  hideEnclosureName={!!l2HeaderEnclosure}
                  enclosureTypeMap={enclosureTypeMap}
                />
              ))}
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
function ZoneSolutionSection({ solution, salesMode, cableGaugeMm2, useFeet, onAdjustEnclosure }: { solution: SolverSolution; salesMode: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void }) {
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
              />
            );
          })
        )}
      </div>
    </div>
  );
}

export default function SolverResults({ zoneSolutions, activeZoneId, salesMode = false, cableGaugeMm2 = 2.5, useFeet = true, onAdjustEnclosure }: SolverResultsProps) {
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
        onAdjustEnclosure={onAdjustEnclosure}
      />
    </div>
  );
}
