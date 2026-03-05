import React, { useState, useMemo, useEffect, useRef } from "react"; // eslint-disable-line
import type { AmpInstance, OutputAllocation, ZoneWithSolution, SolverSolution, Enclosure } from "../types";
import { HARD_FLOOR_IMPEDANCE, MIN_IMPEDANCE_OHMS, getMaxCableLength, calculateCableLoss } from "../types";
import { getImpedanceErrors, repackAmpInstance, spreadAmpInstance, repackRackInstances, spreadRackInstances } from "../solver/ampSolver";
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
  onLockRack?: (ampInstances: AmpInstance[]) => void;
  onUnlockAmpInstance?: (ampInstanceId: string) => void;
  onCombineLockedRacks?: (ampIds: string[]) => void;
  onMoveEnclosure?: (move: EnclosureMoveResult) => void;
  rackNameMap?: Record<string, string>;
  onRackNameChange?: (rackKey: string, name: string) => void;
  perOutputMap?: Record<string, number>;
  hintsEnabled?: boolean;
}

/** Returns inline style for output label color that darkens as output index increases */
function getOutputTealStyle(outputIndex: number, totalOutputs: number): React.CSSProperties {
  const t = totalOutputs <= 1 ? 0 : outputIndex / (totalOutputs - 1);
  const isDark = document.documentElement.classList.contains("dark");
  const lightness = isDark ? 65 - t * 20 : 32 - t * 14;
  return { color: `hsl(180, 60%, ${lightness}%)` };
}

/** Returns inline style for channel label color that darkens as channel index increases */
function getChannelPurpleStyle(channelIndex: number, totalChannels: number): React.CSSProperties {
  const t = totalChannels <= 1 ? 0 : channelIndex / (totalChannels - 1);
  const isDark = document.documentElement.classList.contains("dark");
  const lightness = isDark ? 80 - t * 25 : 60 - t * 30;
  return { color: `hsl(270, 70%, ${lightness}%)` };
}

/** Returns inline style for signal type color within a multi-channel group */
function getSignalTypeGoldStyle(indexInGroup: number, totalInGroup: number): React.CSSProperties {
  const isDark = document.documentElement.classList.contains("dark");
  if (!isDark) return { color: '#1e293b' };
  const t = totalInGroup <= 1 ? 0 : indexInGroup / (totalInGroup - 1);
  const lightness = 45 + t * 20;
  return { color: `hsl(45, 80%, ${lightness}%)` };
}

/** Cable chain gradient: white → vintage gold */
function getCableChainGoldStyle(index: number, total: number): React.CSSProperties {
  const isDark = document.documentElement.classList.contains("dark");
  if (!isDark) return { color: '#1e293b' };
  const t = total <= 1 ? 1 : index / (total - 1);
  const sat = t * 80;
  const lightness = 85 - t * 30;
  return { color: `hsl(45, ${sat}%, ${lightness}%)` };
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

/** Cable length badge for cable chain display: "(35ft)" or "(10m)" with tabular-nums */
function CableLengthBadge({ meters, useFeet }: { meters: number; useFeet: boolean }) {
  if (meters <= 0) return null;
  const value = useFeet ? Math.round(meters / METERS_PER_FOOT) : Math.round(meters);
  const unit = useFeet ? 'ft' : 'm';
  return (
    <span
      className="inline-block text-center"
      style={{ fontVariantNumeric: 'tabular-nums', minWidth: '3em' }}
    >
      ({value}{unit})
    </span>
  );
}

/**
 * Build inline cable chain: connector → breakout → [enc img] → thru → [enc img] → ...
 * Shows the full physical cable path from amp output to daisy-chained enclosures.
 */
function CableChain({ enc, unitCount, ampConfigKey, activeChannels = 1, channelUnitCounts, style, onConnectorClick, cableLengthMeters = 0, useFeet = true }: { enc: Enclosure; unitCount: number; ampConfigKey?: string; activeChannels?: number; channelUnitCounts?: number[]; style?: React.CSSProperties; onConnectorClick?: () => void; cableLengthMeters?: number; useFeet?: boolean }) {
  const [overrideNL4, setOverrideNL4] = useState(false);

  const imgUrl = getEnclosureImage(enc.enclosure, 1);
  const channelsPerUnit = ampConfigKey ? getChannelsPerUnit(enc, ampConfigKey) : 1;
  const isPACOM = channelsPerUnit >= 4 && !overrideNL4;

  // Determine the amp-side connector, breakout, thru (channel) connector, and link (daisy-chain) connector
  let defaultConnector: string;
  let ampConnector: string;
  let breakout: string;
  let thruConnector: string;   // connector label shown on each breakout channel
  let linkConnector: string;   // connector used to daisy-chain enclosures on the same channel
  let canOverride = false;

  const isLA12X = ampConfigKey === "LA12X";

  const singleChannel = channelsPerUnit === 1 && enc.signal_channels.length === 1;

  if (isPACOM) {
    defaultConnector = "PA-COM";
    ampConnector = "PA-COM";
    breakout = "";
    thruConnector = "PA-COM";
    linkConnector = "PA-COM";
    canOverride = false;
  } else if (isLA12X) {
    // LA12X always outputs NL8; breakout depends on how many channels are active
    defaultConnector = "NL8";
    ampConnector = "NL8";
    if (activeChannels >= 3) {
      // 3+ channels: NL8 splits to (4) NL2
      breakout = " → (4) NL2";
      thruConnector = "NL2";
      linkConnector = "NL2";
    } else {
      // NL8 always breaks out to (2) NL4 — show both channels even if only 1 is loaded
      breakout = " → (2) NL4";
      thruConnector = "NL4";
      // Daisy-chain: single-channel enclosures can link with NL2
      linkConnector = singleChannel ? "NL2" : "NL4";
    }
    canOverride = false;
  } else {
    // LA4X / other non-LA12X: connector matches signal channel count
    // 1 signal type → NL2, 2 signal types → NL4
    if (singleChannel) {
      defaultConnector = "NL2";
      ampConnector = "NL2";
      breakout = "";
      thruConnector = "NL2";
      linkConnector = "NL2";
    } else {
      defaultConnector = "NL4";
      ampConnector = "NL4";
      breakout = "";
      thruConnector = "NL4";
      linkConnector = "NL4";
    }
    canOverride = !!onConnectorClick;
  }

  const hasBreakout = breakout !== "";

  // Determine breakout row count from the breakout string
  const breakoutRows = hasBreakout
    ? (breakout.includes("(4)") ? 4 : 2)
    : 0;

  // Physical enclosure count (multi-channel enclosures like K1 use multiple channels per unit)
  const physicalUnits = channelsPerUnit > 1 ? Math.max(1, Math.round(unitCount / channelsPerUnit)) : unitCount;

  // Build enclosure elements for flat (non-breakout) rendering
  const canDaisyChain = enc.parallelAllowed !== false;
  const needsYSplitFlat = !canDaisyChain && physicalUnits > 1 && !hasBreakout;
  const encElements: React.ReactNode[] = [];
  if (needsYSplitFlat) {
    encElements.push(
      <React.Fragment key="ysplit">
        &rarr; <span>{linkConnector} (Y)</span> &rarr;{" "}
        {Array.from({ length: physicalUnits }, (_, u) => (
          <React.Fragment key={`enc-${u}`}>
            {u > 0 && <span> + </span>}
            {imgUrl ? <img src={imgUrl} alt="" className="inline-block h-[14px] w-auto opacity-60" /> : enc.enclosure}
          </React.Fragment>
        ))}
        {" "}
      </React.Fragment>
    );
  } else {
    for (let i = 0; i < physicalUnits; i++) {
      const separator = i === 0 ? "" : (hasBreakout ? "" : ` ${linkConnector} `);
      encElements.push(
        <React.Fragment key={i}>
          {separator}&rarr;{" "}
          {imgUrl ? <img src={imgUrl} alt="" className="inline-block h-[14px] w-auto opacity-60" /> : enc.enclosure}
          {" "}
        </React.Fragment>
      );
    }
  }

  const handleConnectorClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onConnectorClick) {
      onConnectorClick();
    } else if (isPACOM) {
      setOverrideNL4(!overrideNL4);
    }
  };

  // Connector label (clickable or plain)
  const connectorLabel = canOverride ? (
    <span
      className="cursor-pointer underline decoration-dotted hover:opacity-70"
      onClick={handleConnectorClick}
      title={onConnectorClick ? "Click to use NL8" : (overrideNL4 ? `Click to use ${defaultConnector}` : "Click to use NL4")}
    >
      {ampConnector}
    </span>
  ) : (
    <span>{ampConnector}</span>
  );

  // ── Breakout: render branching diagram ──────────────────────────────────────
  if (hasBreakout) {
    const ROW_H = 16;
    const svgH = breakoutRows * ROW_H;
    const svgW = 16;
    const midY = svgH / 2;

    // Build curved paths from center-left to each row's center-right
    const paths: React.ReactNode[] = [];
    for (let i = 0; i < breakoutRows; i++) {
      const targetY = ROW_H / 2 + i * ROW_H;
      paths.push(
        <path
          key={i}
          d={`M 0,${midY} C ${svgW * 0.5},${midY} ${svgW * 0.5},${targetY} ${svgW},${targetY}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.5}
        />
      );
    }

    // Build output rows — use per-channel counts if available, otherwise distribute evenly
    const rows: React.ReactNode[] = [];
    for (let r = 0; r < breakoutRows; r++) {
      const rowCount = channelUnitCounts ? (channelUnitCounts[r] ?? 0) : (() => {
        const perRow = Math.ceil(physicalUnits / breakoutRows);
        const start = r * perRow;
        return Math.min(perRow, Math.max(0, physicalUnits - start));
      })();

      const rowUnits: React.ReactNode[] = [];
      const canDaisyChain = enc.parallelAllowed !== false;
      const needsYSplit = !canDaisyChain && rowCount > 1;
      if (needsYSplit) {
        rowUnits.push(
          <React.Fragment key="ysplit">
            <span>{linkConnector} (Y)</span><span style={{ opacity: 0.4 }}> &rarr; </span>
            {Array.from({ length: rowCount }, (_, u) => (
              <React.Fragment key={`enc-${u}`}>
                {u > 0 && <span> + </span>}
                {imgUrl ? <img src={imgUrl} alt="" className="inline-block h-[14px] w-auto opacity-60" /> : enc.enclosure}
              </React.Fragment>
            ))}
          </React.Fragment>
        );
      } else {
        for (let u = 0; u < rowCount; u++) {
          if (u > 0) {
            rowUnits.push(<span key={`thru-${u}`}> {linkConnector} &rarr; </span>);
          }
          rowUnits.push(
            <React.Fragment key={`enc-${u}`}>
              {imgUrl ? <img src={imgUrl} alt="" className="inline-block h-[14px] w-auto opacity-60" /> : enc.enclosure}
            </React.Fragment>
          );
        }
      }

      const isEmpty = rowUnits.length === 0;
      rows.push(
        <span key={r} className="inline-flex items-center gap-0.5 whitespace-nowrap" style={{ height: `${ROW_H}px` }}>
          <span className={isEmpty ? "opacity-30" : "opacity-60"}><span className="inline-block text-center" style={{ width: '1.1em', fontVariantNumeric: 'tabular-nums' }}>({r + 1})</span> {thruConnector}</span>
          {!isEmpty && <><span className="opacity-40">&rarr;</span>{" "}{rowUnits}</>}
        </span>
      );
    }

    return (
      <span className="ml-1 text-[10px] font-normal inline-flex items-center gap-0" style={style}>
        <span className="inline-flex items-center gap-0.5 mr-0.5">
          &rarr; <CableLengthBadge meters={cableLengthMeters} useFeet={useFeet} /> {connectorLabel}
        </span>
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="flex-shrink-0"
          style={{ verticalAlign: "middle" }}
        >
          {paths}
        </svg>
        <span className="inline-flex flex-col">
          {rows}
        </span>
      </span>
    );
  }

  // ── No breakout: flat inline chain ──────────────────────────────────────────
  // Show thru connector between amp connector and enclosures only if they differ (e.g., NL8 → NL4)
  const showThruLabel = ampConnector !== thruConnector;
  return (
    <span className="ml-1 text-[10px] font-normal inline-flex items-center gap-0.5 flex-wrap" style={style}>
      &rarr; <CableLengthBadge meters={cableLengthMeters} useFeet={useFeet} /> {connectorLabel}
      {showThruLabel && <span> &rarr; {thruConnector}</span>}
      {" "}
      {encElements}
    </span>
  );
}

function buildCableChain(enc: Enclosure | undefined, unitCount: number, ampConfigKey?: string, style?: React.CSSProperties, onConnectorClick?: () => void, activeChannels?: number, channelUnitCounts?: number[], cableLengthMeters?: number, useFeet?: boolean): React.ReactNode {
  if (!enc || unitCount <= 0) return null;
  return <CableChain enc={enc} unitCount={unitCount} ampConfigKey={ampConfigKey} activeChannels={activeChannels} channelUnitCounts={channelUnitCounts} style={style} onConnectorClick={onConnectorClick} cableLengthMeters={cableLengthMeters} useFeet={useFeet} />;
}

/**
 * Combined NL8 output for LA-RAK: shows all 4 channels of one LA12X on a single NL8 cable.
 * Breakout: ≤2 primary outputs → NL8 → (2) NL4, 3+ → NL8 → (4) NL2.
 * Multi-channel hybrids (e.g., Syva Low Syva): show enclosure on primary channel only,
 * secondary (allocated) channels are grayed out.
 */
function CombinedNL8Chain({ instance, cableLengthMeters = 0, useFeet = true }: { instance: AmpInstance; cableLengthMeters?: number; useFeet?: boolean }) {
  const ampConfigKey = instance.ampConfig.key;

  // Collect all loaded enclosures across all outputs
  const allEnclosures: Array<{ enclosure: Enclosure; count: number }> = [];
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      if (entry.count > 0) allEnclosures.push(entry);
    }
  }
  if (allEnclosures.length === 0) return null;

  // Skip PA-COM enclosures (channelsPerUnit >= 4)
  const primaryEnc = allEnclosures[0].enclosure;
  if (getChannelsPerUnit(primaryEnc, ampConfigKey) >= 4) return null;

  // Identify allocated (secondary) channels of multi-channel enclosures
  const allocatedChannels = new Set<number>();
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      if (entry.count > 0) {
        const cpu = getChannelsPerUnit(entry.enclosure, ampConfigKey);
        if (cpu > 1 && output.outputIndex % cpu !== 0) {
          allocatedChannels.add(output.outputIndex);
        }
      }
    }
  }

  // Count primary (non-allocated) loaded channels for breakout decision
  const primaryLoadedCount = instance.outputs.filter(
    o => o.totalEnclosures > 0 && !allocatedChannels.has(o.outputIndex)
  ).length;

  // ≤2 primary outputs → NL4 (2 rows), 3+ → NL2 (4 rows)
  const useNL2 = primaryLoadedCount >= 3;
  const connector = useNL2 ? "NL2" : "NL4";
  const totalOutputs = instance.outputs.length; // e.g., 4 for LA12X

  if (useNL2) {
    // NL2 mode: 4 rows, one per channel
    const breakoutRows = totalOutputs;
    const rowData: Array<Array<{ enclosure: Enclosure; count: number }>> = Array.from({ length: breakoutRows }, () => []);
    for (const output of instance.outputs) {
      if (allocatedChannels.has(output.outputIndex)) continue; // skip secondary channels
      for (const entry of output.enclosures) {
        if (entry.count > 0) {
          const cpu = getChannelsPerUnit(entry.enclosure, ampConfigKey);
          const physCount = cpu > 1 ? Math.max(1, Math.round(entry.count / cpu)) : entry.count;
          rowData[output.outputIndex].push({ enclosure: entry.enclosure, count: physCount });
        }
      }
    }

    const ROW_H = 16;
    const svgH = breakoutRows * ROW_H;
    const svgW = 16;
    const midY = svgH / 2;

    const paths: React.ReactNode[] = [];
    for (let i = 0; i < breakoutRows; i++) {
      const targetY = ROW_H / 2 + i * ROW_H;
      paths.push(
        <path key={i} d={`M 0,${midY} C ${svgW * 0.5},${midY} ${svgW * 0.5},${targetY} ${svgW},${targetY}`}
          fill="none" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      );
    }

    const rows: React.ReactNode[] = [];
    for (let r = 0; r < breakoutRows; r++) {
      const isAllocated = allocatedChannels.has(r);
      const isEmpty = rowData[r].length === 0;
      const isGrayed = isEmpty || isAllocated;
      const rowUnits: React.ReactNode[] = [];
      let unitIdx = 0;
      if (!isAllocated) {
        for (const entry of rowData[r]) {
          const entryImg = getEnclosureImage(entry.enclosure.enclosure, 1);
          const canDaisyChain = entry.enclosure.parallelAllowed !== false;
          const needsYSplit = !canDaisyChain && entry.count > 1;
          if (needsYSplit) {
            // Y-split cable: NL4 (Y) → img + img
            rowUnits.push(
              <React.Fragment key="ysplit">
                <span>{connector} (Y)</span><span style={{ opacity: 0.6 }}> &rarr; </span>
                {Array.from({ length: entry.count }, (_, u) => (
                  <React.Fragment key={`enc-${u}`}>
                    {u > 0 && <span> + </span>}
                    {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
                  </React.Fragment>
                ))}
              </React.Fragment>
            );
            unitIdx += entry.count;
          } else {
            for (let u = 0; u < entry.count; u++) {
              if (unitIdx > 0) rowUnits.push(<span key={`link-${unitIdx}`}> {connector} &rarr; </span>);
              rowUnits.push(
                <React.Fragment key={`enc-${unitIdx}`}>
                  {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
                </React.Fragment>
              );
              unitIdx++;
            }
          }
        }
      }

      const rowGold = getCableChainGoldStyle(r, breakoutRows);
      rows.push(
        <span key={r} className="inline-flex items-center gap-0.5 whitespace-nowrap" style={{ height: `${ROW_H}px`, ...rowGold, opacity: isGrayed ? 0.35 : undefined }}>
          <span><span className="inline-block text-center" style={{ width: '1.1em', fontVariantNumeric: 'tabular-nums' }}>({r + 1})</span> {connector}</span>
          {!isGrayed && rowUnits.length > 0 && <><span style={{ opacity: 0.6 }}>&rarr;</span>{" "}{rowUnits}</>}
        </span>
      );
    }

    const midGold = getCableChainGoldStyle(Math.floor(breakoutRows / 2), breakoutRows);
    return (
      <span className="ml-1 text-[10px] font-normal inline-flex items-center gap-0" style={midGold}>
        <span className="inline-flex items-center gap-0.5 mr-0.5">&rarr; <CableLengthBadge meters={cableLengthMeters} useFeet={useFeet} /> <span>NL8</span></span>
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="flex-shrink-0" style={{ verticalAlign: "middle" }}>{paths}</svg>
        <span className="inline-flex flex-col">{rows}</span>
      </span>
    );
  } else {
    // NL4 mode: 2 rows, each NL4 = 1 channel's cable run
    const breakoutRows = 2;
    const rowData: Array<Array<{ enclosure: Enclosure; count: number }>> = [[], []];

    // Assign primary loaded channels to rows 0 and 1 in order
    let rowIdx = 0;
    const rowAllocated = [false, false]; // track if a row is an allocated secondary channel
    for (const output of instance.outputs) {
      if (rowIdx >= breakoutRows) break;
      const isAllocated = allocatedChannels.has(output.outputIndex);
      const hasLoad = output.totalEnclosures > 0;
      if (!hasLoad && !isAllocated) continue; // skip completely empty channels
      if (isAllocated) {
        // Allocated secondary channel — gray it out
        rowAllocated[rowIdx] = true;
        rowIdx++;
        continue;
      }
      for (const entry of output.enclosures) {
        if (entry.count > 0) {
          const cpu = getChannelsPerUnit(entry.enclosure, ampConfigKey);
          const physCount = cpu > 1 ? Math.max(1, Math.round(entry.count / cpu)) : entry.count;
          rowData[rowIdx].push({ enclosure: entry.enclosure, count: physCount });
        }
      }
      rowIdx++;
    }

    const ROW_H = 16;
    const svgH = breakoutRows * ROW_H;
    const svgW = 16;
    const midY = svgH / 2;

    const paths: React.ReactNode[] = [];
    for (let i = 0; i < breakoutRows; i++) {
      const targetY = ROW_H / 2 + i * ROW_H;
      paths.push(
        <path key={i} d={`M 0,${midY} C ${svgW * 0.5},${midY} ${svgW * 0.5},${targetY} ${svgW},${targetY}`}
          fill="none" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      );
    }

    const rows: React.ReactNode[] = [];
    for (let r = 0; r < breakoutRows; r++) {
      const isEmpty = rowData[r].length === 0;
      const isGrayed = isEmpty || rowAllocated[r];
      const rowUnits: React.ReactNode[] = [];
      let unitIdx = 0;
      if (!rowAllocated[r]) {
        for (const entry of rowData[r]) {
          const entryImg = getEnclosureImage(entry.enclosure.enclosure, 1);
          const canDaisyChain = entry.enclosure.parallelAllowed !== false;
          const needsYSplit = !canDaisyChain && entry.count > 1;
          if (needsYSplit) {
            rowUnits.push(
              <React.Fragment key="ysplit">
                <span>{connector} (Y)</span><span style={{ opacity: 0.6 }}> &rarr; </span>
                {Array.from({ length: entry.count }, (_, u) => (
                  <React.Fragment key={`enc-${u}`}>
                    {u > 0 && <span> + </span>}
                    {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
                  </React.Fragment>
                ))}
              </React.Fragment>
            );
            unitIdx += entry.count;
          } else {
            for (let u = 0; u < entry.count; u++) {
              if (unitIdx > 0) rowUnits.push(<span key={`link-${unitIdx}`}> {connector} &rarr; </span>);
              rowUnits.push(
                <React.Fragment key={`enc-${unitIdx}`}>
                  {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
                </React.Fragment>
              );
              unitIdx++;
            }
          }
        }
      }

      const rowGold = getCableChainGoldStyle(r, breakoutRows);
      rows.push(
        <span key={r} className="inline-flex items-center gap-0.5 whitespace-nowrap" style={{ height: `${ROW_H}px`, ...rowGold, opacity: isGrayed ? 0.35 : undefined }}>
          <span><span className="inline-block text-center" style={{ width: '1.1em', fontVariantNumeric: 'tabular-nums' }}>({r + 1})</span> {connector}</span>
          {!isGrayed && rowUnits.length > 0 && <><span style={{ opacity: 0.6 }}>&rarr;</span>{" "}{rowUnits}</>}
        </span>
      );
    }

    const midGold = getCableChainGoldStyle(Math.floor(breakoutRows / 2), breakoutRows);
    return (
      <span className="ml-1 text-[10px] font-normal inline-flex items-center gap-0" style={midGold}>
        <span className="inline-flex items-center gap-0.5 mr-0.5">&rarr; <CableLengthBadge meters={cableLengthMeters} useFeet={useFeet} /> <span>NL8</span></span>
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="flex-shrink-0" style={{ verticalAlign: "middle" }}>{paths}</svg>
        <span className="inline-flex flex-col">{rows}</span>
      </span>
    );
  }
}

/**
 * Combined PA-COM output: shows PA-COM cable chains for enclosures using 4+ channels per unit.
 * Groups enclosures by physical connector (based on outputIndex / cpu).
 * Single group: flat inline chain. Multiple groups: one cable branching via SVG curves into
 * separate PA-COM rows (like the NL8 breakout pattern).
 * Rendered below output cards, same placement as CombinedNL8Chain.
 */
function CombinedPACOMChain({ instance, fontSize = 8, cableLengthMeters = 0, useFeet = true }: { instance: AmpInstance; fontSize?: number; cableLengthMeters?: number; useFeet?: boolean }) {
  const ampConfigKey = instance.ampConfig.key;

  // Collect PA-COM enclosures grouped by physical connector
  const connectorGroups = new Map<number, Array<{ enclosure: Enclosure; count: number }>>();
  for (const output of instance.outputs) {
    for (const entry of output.enclosures) {
      if (entry.count > 0) {
        const cpu = getChannelsPerUnit(entry.enclosure, ampConfigKey);
        if (cpu >= 4 && output.outputIndex % cpu === 0) {
          const connectorIdx = Math.floor(output.outputIndex / cpu);
          if (!connectorGroups.has(connectorIdx)) connectorGroups.set(connectorIdx, []);
          connectorGroups.get(connectorIdx)!.push(entry);
        }
      }
    }
  }
  if (connectorGroups.size === 0) return null;

  const groups = Array.from(connectorGroups.entries()).sort((a, b) => a[0] - b[0]);

  // Single connector group: flat inline chain (original behavior)
  if (groups.length === 1) {
    const [, entries] = groups[0];
    let totalUnits = 0;
    for (const entry of entries) totalUnits += entry.count;
    const totalSegments = 3 + totalUnits + (totalUnits > 1 ? (totalUnits - 1) * 2 : 0);

    const elements: React.ReactNode[] = [];
    let segIdx = 0;
    elements.push(<span key="a0" style={getCableChainGoldStyle(segIdx++, totalSegments)}>&rarr;</span>);
    if (cableLengthMeters > 0) {
      elements.push(<CableLengthBadge key="len" meters={cableLengthMeters} useFeet={useFeet} />);
    }
    elements.push(<span key="pacom0" style={getCableChainGoldStyle(segIdx++, totalSegments)}> PA-COM </span>);
    elements.push(<span key="a1" style={getCableChainGoldStyle(segIdx++, totalSegments)}>&rarr; </span>);

    let unitIdx = 0;
    for (const entry of entries) {
      const entryImg = getEnclosureImage(entry.enclosure.enclosure, 1);
      for (let u = 0; u < entry.count; u++) {
        if (unitIdx > 0) {
          elements.push(<span key={`link-${unitIdx}`} style={getCableChainGoldStyle(segIdx++, totalSegments)}> PA-COM </span>);
          elements.push(<span key={`arr-${unitIdx}`} style={getCableChainGoldStyle(segIdx++, totalSegments)}>&rarr; </span>);
        }
        elements.push(
          <span key={`enc-${unitIdx}`} style={getCableChainGoldStyle(segIdx++, totalSegments)}>
            {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
          </span>
        );
        unitIdx++;
      }
    }

    return (
      <span className="ml-1 font-normal inline-flex items-center gap-0.5" style={{ fontSize: `${fontSize}px` }}>
        {elements}
      </span>
    );
  }

  // Multiple connector groups: one cable branching into separate PA-COM rows
  const ROW_H = 16;
  const branchCount = groups.length;
  const svgH = branchCount * ROW_H;
  const svgW = 16;
  const midY = svgH / 2;

  // SVG branch curves from center to each row
  const paths: React.ReactNode[] = [];
  for (let i = 0; i < branchCount; i++) {
    const targetY = ROW_H / 2 + i * ROW_H;
    paths.push(
      <path
        key={i}
        d={`M 0,${midY} C ${svgW * 0.5},${midY} ${svgW * 0.5},${targetY} ${svgW},${targetY}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.5}
      />
    );
  }

  // Build rows — each connector group gets its own row
  const rows = groups.map(([connIdx, entries], rowIdx) => {
    let totalUnits = 0;
    for (const entry of entries) totalUnits += entry.count;

    const rowElements: React.ReactNode[] = [];
    let unitIdx = 0;
    for (const entry of entries) {
      const entryImg = getEnclosureImage(entry.enclosure.enclosure, 1);
      for (let u = 0; u < entry.count; u++) {
        if (unitIdx > 0) {
          rowElements.push(<span key={`link-${connIdx}-${unitIdx}`}> PA-COM &rarr; </span>);
        }
        rowElements.push(
          <React.Fragment key={`enc-${connIdx}-${unitIdx}`}>
            {entryImg ? <img src={entryImg} alt="" className="inline-block h-[14px] w-auto" /> : entry.enclosure.enclosure}
          </React.Fragment>
        );
        unitIdx++;
      }
    }

    const rowGold = getCableChainGoldStyle(rowIdx, branchCount);
    return (
      <span key={rowIdx} className="inline-flex items-center gap-0.5 whitespace-nowrap" style={{ height: `${ROW_H}px`, ...rowGold }}>
        <span><span className="inline-block text-center" style={{ width: '1.1em', fontVariantNumeric: 'tabular-nums' }}>({rowIdx + 1})</span> PA-COM</span>
        {rowElements.length > 0 && <><span style={{ opacity: 0.6 }}>&rarr;</span>{" "}{rowElements}</>}
      </span>
    );
  });

  const midGold = getCableChainGoldStyle(Math.floor(branchCount / 2), branchCount);
  return (
    <span className="ml-1 font-normal inline-flex items-center gap-0" style={{ fontSize: `${fontSize}px`, ...midGold }}>
      <span className="inline-flex items-center gap-0.5 mr-0.5">
        &rarr; <CableLengthBadge meters={cableLengthMeters} useFeet={useFeet} /> <span>PA-COM</span>
      </span>
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="flex-shrink-0"
        style={{ verticalAlign: "middle" }}
      >
        {paths}
      </svg>
      <span className="inline-flex flex-col">
        {rows}
      </span>
    </span>
  );
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

const ENCLOSURE_TYPE_COLORS = [
  "rgba(189, 199, 124, 0.15)",
  "rgba(132, 190, 197, 0.15)",
  "rgba(222, 170, 66, 0.15)",
];

const ENCLOSURE_TYPE_COLORS_DARK = [
  "rgba(189, 199, 124, 0.12)",
  "rgba(132, 190, 197, 0.12)",
  "rgba(222, 170, 66, 0.12)",
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
        <span><span style={{ color: '#946F10' }}>Estimated</span> max cable: <span className="font-medium text-gray-700 dark:text-neutral-300">{lengthDisplay}</span></span>
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

const OUTPUT_COLORS_LIGHT = [
  { stroke: "#4A9B9B", fill: "rgba(74, 155, 155, 0.12)" },
  { stroke: "#8B7FB8", fill: "rgba(139, 127, 184, 0.12)" },
  { stroke: "#5DB572", fill: "rgba(93, 181, 114, 0.12)" },
  { stroke: "#B87F8B", fill: "rgba(184, 127, 139, 0.12)" },
  { stroke: "#B89B7F", fill: "rgba(184, 155, 127, 0.12)" },
];

const OUTPUT_COLORS_DARK = [
  { stroke: "#5DBDBD", fill: "rgba(93, 189, 189, 0.15)" },
  { stroke: "#A599D4", fill: "rgba(165, 153, 212, 0.15)" },
  { stroke: "#77D48F", fill: "rgba(119, 212, 143, 0.15)" },
  { stroke: "#D499A6", fill: "rgba(212, 153, 166, 0.15)" },
  { stroke: "#D4B899", fill: "rgba(212, 184, 153, 0.15)" },
];

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
  const OUTPUT_COLORS_LIGHT = [
    { stroke: "#4A9B9B" }, { stroke: "#8B7FB8" }, { stroke: "#5DB572" }, { stroke: "#B87F8B" }, { stroke: "#B89B7F" },
  ];
  const OUTPUT_COLORS_DARK = [
    { stroke: "#5DBDBD" }, { stroke: "#A599D4" }, { stroke: "#77D48F" }, { stroke: "#D499A6" }, { stroke: "#D4B899" },
  ];
  const palette = isDark ? OUTPUT_COLORS_DARK : OUTPUT_COLORS_LIGHT;
  const outputColor = outputIndex !== undefined
    ? palette[outputIndex % palette.length]?.stroke
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

function OutputCard({ output, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, isSecondaryChannel = false, hideEnclosureName = false, enclosureTypeMap, inputLetter, routing, onRoutingChange, ampConfigKey, ampId, ampModel, isLocked = false, cableLengthMeters = 0, onCableLengthChange, isInRack = false, showCableChain = false, onConnectorClick }: { output: OutputAllocation; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; isSecondaryChannel?: boolean; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetter?: string; routing?: RoutingOption; onRoutingChange?: (value: RoutingOption) => void; ampConfigKey?: string; ampId?: string; ampModel?: string; isLocked?: boolean; cableLengthMeters?: number; onCableLengthChange?: (meters: number) => void; isInRack?: boolean; showCableChain?: boolean; onConnectorClick?: () => void }) {
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

            <div className="flex-1 flex flex-col">
              <div>
                {/* Show grayed-out enclosure name and signal type */}
                {output.enclosures.map((entry, i) => {
                  const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                  const channelName = channelsPerUnit > 1
                    ? entry.enclosure.signal_channel_names?.[
                        channelsPerUnit === 1
                          ? entry.enclosure.signal_channels.join("+")
                          : entry.enclosure.signal_channels[output.outputIndex % channelsPerUnit]
                      ]
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
                    </div>
                  );
                })}
              </div>
              {/* Signal type - pinned to bottom for cross-channel alignment */}
              <div className="mt-auto">
                {output.enclosures.map((entry, i) => {
                  const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                  const posInGroup = output.outputIndex % channelsPerUnit;
                  const totalInGroup = channelsPerUnit;
                  const signalType = channelsPerUnit === 1
                    ? entry.enclosure.signal_channels.join("+")
                    : entry.enclosure.signal_channels[posInGroup];
                  return (
                    <div
                      key={i}
                      className="text-[10px] font-medium"
                      style={getSignalTypeGoldStyle(posInGroup, totalInGroup)}
                    >
                      {signalType}
                    </div>
                  );
                })}
              </div>
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
        {showCableChain && !is16Channel && output.totalEnclosures > 0 && getChannelsPerUnit(output.enclosures[0]?.enclosure, ampConfigKey) < 4 && buildCableChain(
          output.enclosures[0]?.enclosure,
          output.totalEnclosures,
          ampConfigKey,
          getOutputTealStyle(output.outputIndex, ampOutputCount),
          onConnectorClick,
          1, // single output = 1 active channel
          undefined,
          cableLengthMeters,
          useFeet
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
              <div className="flex-1 flex flex-col">
                <div>
                  {(() => {
                    const maxRated = ratedImpedances.length > 0 ? Math.max(...ratedImpedances) : Infinity;
                    const isMultiChannel = output.enclosures.some(e => getChannelsPerUnit(e.enclosure, ampConfigKey) > 1);
                    const impedanceAboveRated = !isMultiChannel && output.impedanceOhms !== Infinity && output.impedanceOhms > maxRated;
                    return output.enclosures.map((entry, i) => {
                      const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                      const posInGroup = output.outputIndex % (channelsPerUnit || 1);
                      const channelName = channelsPerUnit > 1
                        ? entry.enclosure.signal_channel_names?.[
                            channelsPerUnit === 1
                              ? entry.enclosure.signal_channels.join("+")
                              : entry.enclosure.signal_channels[posInGroup]
                          ]
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
                        </div>
                      );
                    });
                  })()}
                </div>
                {/* Signal type - pinned to bottom for cross-channel alignment */}
                <div className="mt-auto">
                  {output.enclosures.map((entry, i) => {
                    const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                    const posInGroup = output.outputIndex % (channelsPerUnit || 1);
                    const signalType = channelsPerUnit === 1
                      ? entry.enclosure.signal_channels.join("+")
                      : entry.enclosure.signal_channels[posInGroup];
                    return (
                      <div
                        key={i}
                        className="text-[10px] font-medium"
                        style={getSignalTypeGoldStyle(0, 1)}
                      >
                        {signalType}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Bottom section: routing, impedance, and cable controls */}
              <div className="mt-auto pt-1 space-y-1">
                {/* Routing selector at left, impedance at right */}
                <div className="flex items-end justify-between text-[10px]">
                  <div className="flex items-center gap-1">
                    {onRoutingChange && (
                      <RoutingSelector value={routing ?? "A"} onChange={onRoutingChange} />
                    )}
                  </div>
                  <span className={hasImpedanceError ? "text-red-600 dark:text-red-500 font-bold" : "text-gray-400 dark:text-neutral-500"}>
                    {output.impedanceOhms === Infinity ? "" : `${output.impedanceOhms}Ω`}
                  </span>
                </div>
                {/* Cable controls */}
                {output.impedanceOhms !== Infinity && output.impedanceOhms > 0 && onCableLengthChange && (
                  <div className="flex items-center gap-2 flex-wrap text-[10px]">
                    <CableLengthInput lengthMeters={cableLengthMeters} onChange={onCableLengthChange} useFeet={useFeet} outputIndex={output.outputIndex} />
                    <CableLossDisplay impedanceOhms={output.impedanceOhms} cableLengthMeters={cableLengthMeters} gaugeMm2={cableGaugeMm2} />
                  </div>
                )}
              </div>
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
function MultiChannelOutputCard({ outputs, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, hideEnclosureName = false, enclosureTypeMap, inputLetters, routings, onRoutingChange, ampConfigKey, cableLengthMeters = 0, onCableLengthChange, isInRack = false, showCableChain = false, onConnectorClick }: { outputs: OutputAllocation[]; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; hideEnclosureName?: boolean; enclosureTypeMap?: Map<string, number>; inputLetters?: string[]; routings?: RoutingOption[]; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void; ampConfigKey?: string; cableLengthMeters?: number; onCableLengthChange?: (meters: number) => void; isInRack?: boolean; showCableChain?: boolean; onConnectorClick?: () => void }) {
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
          {showCableChain && getChannelsPerUnit(primaryOutput.enclosures[0]?.enclosure, ampConfigKey) < 4 && buildCableChain(
            primaryOutput.enclosures[0]?.enclosure,
            outputs.reduce((sum, o) => sum + o.totalEnclosures, 0),
            ampConfigKey,
            getOutputTealStyle(primaryOutput.outputIndex, ampOutputCount),
            onConnectorClick,
            channelCount, // number of active channels in this multi-channel group
            outputs.map(o => o.totalEnclosures),
            cableLengthMeters,
            useFeet
          )}
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
                  <div className="pt-1 font-medium truncate" style={getChannelPurpleStyle(output.outputIndex, ampOutputCount)}>
                    Ch {output.outputIndex + 1}
                    {hasChannelError && (
                      <span className="ml-1 text-red-600 dark:text-red-500 font-bold">ERROR</span>
                    )}
                  </div>

                  {/* Separator line for each channel */}
                  <div className={`border-t my-1 ${hasChannelError ? "border-red-200 dark:border-red-800" : "border-blue-200/60 dark:border-neutral-700"}`} />

                  {/* Enclosure info */}
                  <div className="flex-1 flex flex-col">
                    <div>
                      {output.enclosures.map((entry, i) => {
                        const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                        const channelName = channelsPerUnit > 1
                          ? entry.enclosure.signal_channel_names?.[
                              channelsPerUnit === 1
                                ? entry.enclosure.signal_channels.join("+")
                                : entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length]
                            ]
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
                          </div>
                        );
                      })}
                    </div>
                    {/* Signal type - pinned to bottom of content area for cross-channel alignment */}
                    <div className="mt-auto">
                      {output.enclosures.map((entry, i) => {
                        const channelsPerUnit = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                        const signalType = channelsPerUnit === 1
                          ? entry.enclosure.signal_channels.join("+")
                          : entry.enclosure.signal_channels[output.outputIndex % entry.enclosure.signal_channels.length];
                        return (
                          <div
                            key={i}
                            className="text-[10px] font-medium"
                            style={getSignalTypeGoldStyle(idx, channelCount)}
                          >
                            {signalType}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Routing selector at left, impedance at right */}
                  <div className="flex items-center justify-between pt-1 text-[10px] mt-auto">
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
          {/* Cable controls: fixed bottom-left position */}
          {primaryOutput.impedanceOhms !== Infinity && primaryOutput.impedanceOhms > 0 && onCableLengthChange && (
            <div className="flex items-center gap-2 flex-wrap pt-1 text-[10px]">
              <CableLengthInput lengthMeters={cableLengthMeters} onChange={onCableLengthChange} useFeet={useFeet} outputIndex={primaryOutput.outputIndex} />
              <CableLossDisplay impedanceOhms={primaryOutput.impedanceOhms} cableLengthMeters={cableLengthMeters} gaugeMm2={cableGaugeMm2} />
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
function PhysicalOutputCard({ outputs, physicalIndex, ampOutputCount, salesMode = false, cableGaugeMm2, useFeet, ratedImpedances = [], onAdjustEnclosure, enclosureTypeMap, inputLettersMap, routingMap, onRoutingChange, ampConfigKey, cableLengths, ampId, onCableLengthChange, isInRack = false, showCableChain = false, onConnectorClick }: { outputs: OutputAllocation[]; physicalIndex: number; ampOutputCount: number; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; ratedImpedances?: number[]; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; enclosureTypeMap?: Map<string, number>; inputLettersMap?: string[]; routingMap?: Record<number, RoutingOption>; onRoutingChange?: (channelIndex: number, value: RoutingOption) => void; ampConfigKey?: string; cableLengths?: Record<string, number>; ampId?: string; onCableLengthChange?: (outputIndex: number, meters: number) => void; isInRack?: boolean; showCableChain?: boolean; onConnectorClick?: () => void }) {
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
        {showCableChain && totalEnclosures > 0 && (() => {
          const loadedOutput = outputs.find(o => o.enclosures.length > 0);
          const enc = loadedOutput?.enclosures[0]?.enclosure;
          if (getChannelsPerUnit(enc, ampConfigKey) >= 4) return null;
          const loadedChannels = outputs.filter(o => o.totalEnclosures > 0).length;
          const firstCableLength = cableLengths?.[`${ampId}:${outputs[0].outputIndex}`] ?? 0;
          return buildCableChain(enc, totalEnclosures, ampConfigKey, getOutputTealStyle(physicalIndex, ampOutputCount / 2), onConnectorClick, loadedChannels, outputs.map(o => o.totalEnclosures), firstCableLength, useFeet);
        })()}
      </div>
      {hasLoad ? (
        <>
          {!salesMode ? (
            <div className={`flex flex-col border-t ${hasImpedanceError ? "border-red-200 dark:border-red-800" : "border-blue-200 dark:border-neutral-700"}`}>
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
                        className={`flex-1 flex flex-col rounded -mx-1 px-1 ${!isFirstInPhysical ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
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
                                <div className="flex-1 flex flex-col">
                                  <div>
                                    {grpOutput.enclosures.map((entry, i) => {
                                      const entryChannels = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                                      const channelName = entryChannels > 1
                                        ? entry.enclosure.signal_channel_names?.[
                                            entryChannels === 1
                                              ? entry.enclosure.signal_channels.join("+")
                                              : entry.enclosure.signal_channels[posInGroup]
                                          ]
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
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {/* Signal type - pinned to bottom for cross-channel alignment */}
                                  <div className="mt-auto">
                                    {grpOutput.enclosures.map((entry, i) => {
                                      const entryChannels = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                                      const signalType = entryChannels === 1
                                        ? entry.enclosure.signal_channels.join("+")
                                        : entry.enclosure.signal_channels[posInGroup];
                                      return (
                                        <div
                                          key={i}
                                          className="text-[10px] font-medium"
                                          style={getSignalTypeGoldStyle(posInGroup, channelsPerUnit)}
                                        >
                                          {signalType}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                                {/* Routing selector at left, impedance at right */}
                                <div className="flex items-end justify-between pt-1 text-[10px] mt-auto">
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
                        {/* Cable controls: fixed bottom-left position */}
                        {groupOutputs[0].impedanceOhms !== Infinity && groupOutputs[0].impedanceOhms > 0 && onCableLengthChange && ampId && (
                          <div className="flex items-center gap-2 flex-wrap pt-1 text-[10px]">
                            <CableLengthInput lengthMeters={cableLengths?.[`${ampId}:${groupOutputs[0].outputIndex}`] ?? 0} onChange={(m) => onCableLengthChange(groupOutputs[0].outputIndex, m)} useFeet={useFeet} outputIndex={groupOutputs[0].outputIndex} />
                            <CableLossDisplay impedanceOhms={groupOutputs[0].impedanceOhms} cableLengthMeters={cableLengths?.[`${ampId}:${groupOutputs[0].outputIndex}`] ?? 0} gaugeMm2={cableGaugeMm2} />
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
                        className={`flex-1 flex flex-col rounded -mx-1 px-1 ${!isFirstInPhysical ? "mt-2 pt-1 border-t border-dashed border-gray-200 dark:border-neutral-700" : "pt-1"}`}
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
                                    <div className="flex-1 flex flex-col">
                                      <div>
                                        {grpOutput.enclosures.map((entry, i) => {
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
                                            </div>
                                          );
                                        })}
                                      </div>
                                      {/* Signal type - pinned to bottom for cross-channel alignment */}
                                      <div className="mt-auto">
                                        {grpOutput.enclosures.map((entry, i) => {
                                          const entryChannels = getChannelsPerUnit(entry.enclosure, ampConfigKey);
                                          return (
                                            <div
                                              key={i}
                                              className="text-[10px] font-medium"
                                              style={getSignalTypeGoldStyle(0, 1)}
                                            >
                                              {entryChannels === 1
                                                ? entry.enclosure.signal_channels.join("+")
                                                : entry.enclosure.signal_channels[grpOutput.outputIndex % entry.enclosure.signal_channels.length]}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                    {/* Routing selector at left, impedance at right */}
                                    <div className="flex items-end justify-between pt-1 text-[10px] mt-auto">
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
                                    <div className="flex items-end justify-between pt-1 text-[10px] mt-auto">
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
                        {/* Cable controls: fixed bottom-left position */}
                        {firstWithLoad && firstWithLoad.impedanceOhms !== Infinity && firstWithLoad.impedanceOhms > 0 && onCableLengthChange && ampId && (
                          <div className="flex items-center gap-2 flex-wrap pt-1 text-[10px]">
                            <CableLengthInput lengthMeters={cableLengths?.[`${ampId}:${firstWithLoad.outputIndex}`] ?? 0} onChange={(m) => onCableLengthChange(firstWithLoad.outputIndex, m)} useFeet={useFeet} outputIndex={firstWithLoad.outputIndex} />
                            <CableLossDisplay impedanceOhms={firstWithLoad.impedanceOhms} cableLengthMeters={cableLengths?.[`${ampId}:${firstWithLoad.outputIndex}`] ?? 0} gaugeMm2={cableGaugeMm2} />
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
                <div className="flex items-end justify-between pt-1 text-[10px] mt-auto">
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
function LaRakCard({ rackIndex, instances, cableGaugeMm2, useFeet, onAdjustEnclosure, packedMap, spreadMap, onTogglePacked, onToggleSpread, lockedAmpIds, onLockAmpInstance, onLockRack, onUnlockAmpInstance, globalIndices, canCombineWithOthers = false, onCombineRacks, cableLengths, onCableLengthChange, rackDistributeMode, onRackToggle, rackName, onRackNameChange, perOutputMap, fontBonus = 0 }: { rackIndex: number; instances: AmpInstance[]; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packedMap: Record<number, boolean>; spreadMap: Record<number, boolean>; onTogglePacked: (index: number) => void; onToggleSpread: (index: number) => void; lockedAmpIds?: Set<string>; onLockAmpInstance?: (ampInstance: AmpInstance) => void; onLockRack?: (ampInstances: AmpInstance[]) => void; onUnlockAmpInstance?: (ampInstanceId: string) => void; globalIndices: number[]; canCombineWithOthers?: boolean; onCombineRacks?: () => void; cableLengths?: Record<string, number>; onCableLengthChange?: (ampIndex: number, outputIndex: number, meters: number) => void; rackDistributeMode?: "spread" | "packed"; onRackToggle?: () => void; rackName?: string; onRackNameChange?: (rackKey: string, name: string) => void; perOutputMap?: Record<string, number>; fontBonus?: number }) {
  const RACK_SLOTS = 3;
  const emptySlots = RACK_SLOTS - instances.length;
  // Helper: apply fontBonus to a base pixel size
  const fb = (base: number) => fontBonus > 0 ? `${base + fontBonus}px` : undefined;
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Rack is locked when ALL real instances are locked
  const isRackLocked = instances.length > 0 && instances.every(
    (inst) => lockedAmpIds?.has(inst.id) ?? false
  );

  // Total enclosures across all amps in the rack (for showing rack-level toggle)
  const totalRackEnclosures = instances.reduce((sum, inst) => sum + inst.totalEnclosures, 0);
  const showRackToggle = totalRackEnclosures > 1 && !isRackLocked;

  // Apply rack-level distribution when active
  // Pad instances to fill all rack slots so enclosures can spread across all amps
  const transformedInstances = useMemo(() => {
    if (!rackDistributeMode) return instances;

    // Pad to RACK_SLOTS with empty amps so distribution has all channels available
    const padded = [...instances];
    while (padded.length < RACK_SLOTS) {
      const ampConfig = instances[0].ampConfig;
      padded.push({
        id: `rack-${rackIndex}-virtual-${padded.length}`,
        ampConfig,
        outputs: Array.from({ length: ampConfig.outputs }, (_, oi) => ({
          outputIndex: oi,
          enclosures: [],
          totalEnclosures: 0,
          impedanceOhms: Infinity,
        })),
        totalEnclosures: 0,
        loadPercent: 0,
      });
    }

    if (rackDistributeMode === "spread") {
      return spreadRackInstances(repackRackInstances(padded), perOutputMap);
    }
    return repackRackInstances(padded);
  }, [rackDistributeMode, instances, rackIndex, perOutputMap]);

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
              // Preserve the rack's display name so the unlocked rack keeps it
              if (rackName && onRackNameChange) {
                const rackKey = instances[0]?.rackGroupId;
                if (rackKey) {
                  onRackNameChange("pending-unlock", rackName);
                  onRackNameChange(rackKey, ""); // clear locked key
                }
              }
              for (const inst of instances) {
                onUnlockAmpInstance?.(inst.id);
              }
            }}
            className="rounded p-1 transition-colors"
            style={{ backgroundColor: 'rgba(181, 158, 95, 0.2)', color: document.documentElement.classList.contains('dark') ? '#b59e5f' : '#7A6B3A' }}
            title="Unlock all amplifiers in this rack"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </button>
        ) : (onLockRack || onLockAmpInstance) && (
          <button
            onClick={() => {
              // Generate a unique rackGroupId for all amps locked together
              const rackGroupId = `rack-${crypto.randomUUID().split("-").pop()}`;
              // Save the current display name so it persists after locking
              if (rackName && onRackNameChange) {
                onRackNameChange(rackGroupId, rackName);
              }
              // Collect all amps to lock, attach rackGroupId
              const instancesToLock = rackDistributeMode ? transformedInstances : instances;
              const ampsToLock = instancesToLock
                .filter(inst => !(lockedAmpIds?.has(inst.id)))
                .map(inst => ({ ...inst, rackGroupId }));
              // Batch lock all amps in a single state update to avoid partial locks
              if (onLockRack && ampsToLock.length > 0) {
                onLockRack(ampsToLock);
              } else {
                for (const inst of ampsToLock) {
                  onLockAmpInstance?.(inst);
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
        {isEditingName && isRackLocked ? (
          <input
            ref={nameInputRef}
            className="text-sm font-bold tracking-wider text-gray-700 dark:text-neutral-300 bg-white dark:bg-neutral-800 border border-gray-300 dark:border-neutral-600 rounded px-1 py-0 outline-none focus:ring-1 focus:ring-blue-400"
            style={{ width: `${Math.max(6, editName.length + 1)}ch` }}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => {
              const trimmed = editName.trim();
              if (trimmed && onRackNameChange) {
                const rackKey = instances[0]?.rackGroupId ?? `locked-${rackIndex}`;
                onRackNameChange(rackKey, trimmed);
              }
              setIsEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setIsEditingName(false);
              }
            }}
            autoFocus
          />
        ) : isRackLocked ? (
          <span
            className="text-sm font-bold tracking-wider text-gray-700 dark:text-neutral-300 cursor-pointer hover:underline decoration-dotted"
            onClick={() => {
              setEditName(rackName || `LA-RAK #${rackIndex + 1}`);
              setIsEditingName(true);
            }}
            title="Click to rename"
          >
            {rackName || `LA-RAK #${rackIndex + 1}`}
          </span>
        ) : (
          <span className="text-sm font-bold tracking-wider text-gray-700 dark:text-neutral-300">
            {rackName || `LA-RAK #${rackIndex + 1}`}
          </span>
        )}
        <span className="text-xs text-gray-500 dark:text-neutral-500">
          {(rackDistributeMode ? transformedInstances.filter(inst => inst.totalEnclosures > 0).length : instances.length)}/{RACK_SLOTS} Amps in use
        </span>
        {/* Rack-level distribute toggle */}
        {showRackToggle && onRackToggle && (
          <button
            onClick={onRackToggle}
            className={`ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              rackDistributeMode === "packed"
                ? "bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:hover:bg-purple-900/60"
                : "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300 dark:hover:bg-green-900/60"
            }`}
            title={rackDistributeMode === "packed" ? "Rack: Packed — click to prioritize channels" : "Rack: Prioritize Channels — click for packed"}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {rackDistributeMode === "packed" ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
              )}
            </svg>
            {rackDistributeMode === "packed" ? "Rack: Packed" : "Rack: Prioritize Channels"}
          </button>
        )}
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
          {instances.map((instance, rackLocalIdx) => {
            const ampOutputCount = instance.ampConfig.outputs;
            const rackCablePrefix = isRackLocked ? instance.id : (globalIndices[rackLocalIdx] !== undefined ? String(globalIndices[rackLocalIdx]) : instance.id);
            const rackMaxCableLength = Math.max(0, ...instance.outputs.map(o => cableLengths?.[`${rackCablePrefix}:${o.outputIndex}`] ?? 0));
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
                      <span className="rounded bg-blue-100 px-1 py-0.5 text-[8px] font-medium text-blue-800 dark:bg-neutral-700 dark:text-gray-300" style={{ fontSize: fb(8) }}>
                        {instance.ampConfig.mode}
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] font-medium ${getLoadColor(instance.loadPercent)}`} style={{ fontSize: fb(10) }}>
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
                          <span className="text-[8px] font-medium" style={{ ...getOutputTealStyle(outputIdx, physicalOutputCount), fontSize: fb(8) }}>
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
                        <div className="text-[9px] font-medium" style={{ ...getChannelPurpleStyle(output.outputIndex, ampOutputCount), fontSize: fb(9) }}>
                          Ch {output.outputIndex + 1}
                        </div>
                        {hasLoad ? (
                          <div className="text-[9px] leading-tight" style={{ fontSize: fb(9) }}>
                            {output.enclosures.map((entry, i) => {
                              const channelsPerUnit = getChannelsPerUnit(entry.enclosure, instance.ampConfig.key);
                              const posInGroup = output.outputIndex % channelsPerUnit;
                              const isPrimary = posInGroup === 0;
                              const channelName = channelsPerUnit > 1
                                ? entry.enclosure.signal_channel_names?.[entry.enclosure.signal_channels[posInGroup]]
                                : undefined;
                              const signalLabel = channelsPerUnit === 1
                                ? entry.enclosure.signal_channels.join("+")
                                : entry.enclosure.signal_channels[posInGroup];
                              return (
                                <div key={i}>
                                  {isPrimary || channelsPerUnit === 1 ? (
                                    <div className="text-gray-700 dark:text-gray-300">
                                      {entry.count}x {entry.enclosure.enclosure}
                                    </div>
                                  ) : (
                                    <div className="text-[7px] italic text-gray-400 dark:text-neutral-600" style={{ fontSize: fb(7) }}>Allocated</div>
                                  )}
                                  {channelName && (
                                    <div className="text-[7px] text-gray-400 dark:text-neutral-500" style={{ fontSize: fb(7) }}>
                                      {entry.count > 1 ? `(${entry.count})` : ""}  {channelName}
                                    </div>
                                  )}
                                  <div className="text-[8px] font-medium" style={{ ...getSignalTypeGoldStyle(posInGroup, channelsPerUnit), fontSize: fb(8) }}>
                                    {signalLabel}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-[9px] text-gray-300 dark:text-neutral-600" style={{ fontSize: fb(9) }}>—</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Cable adapter suggestion centered below signal types — fixed height to align amp cards */}
                <div
                  className="flex justify-center items-center px-1 pb-1"
                  style={{ minHeight: `${ampOutputCount * 16}px` }}
                >
                  <CombinedNL8Chain instance={instance} cableLengthMeters={rackMaxCableLength} useFeet={useFeet} />
                  <CombinedPACOMChain instance={instance} fontSize={12} cableLengthMeters={rackMaxCableLength} useFeet={useFeet} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Expanded view with full AmpCards */
        <div className="space-y-3">
          {(() => {
            const useRackMode = !!rackDistributeMode;
            // When rack mode is active, render transformedInstances that have enclosures
            // Empty virtual amps are shown as empty rack slots instead
            const renderList = useRackMode
              ? transformedInstances.filter(inst => inst.totalEnclosures > 0)
              : instances;

            return renderList.map((inst, localIdx) => {
              const globalIdx = localIdx < globalIndices.length ? globalIndices[localIdx] : undefined;
              const packed = useRackMode ? false : (packedMap[globalIdx ?? 0] ?? false);
              const spread = useRackMode ? false : (spreadMap[globalIdx ?? 0] ?? false);

              const isInstLocked = lockedAmpIds?.has(inst.id) ?? false;
              return (
                <AmpCard
                  key={inst.id}
                  instance={inst}
                  salesMode={false}
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  onAdjustEnclosure={onAdjustEnclosure}
                  packed={packed}
                  spread={spread}
                  onTogglePacked={useRackMode ? () => {} : () => globalIdx !== undefined && onTogglePacked(globalIdx)}
                  onToggleSpread={useRackMode ? () => {} : () => globalIdx !== undefined && onToggleSpread(globalIdx)}
                  hidePackToggle={useRackMode}
                  isInRack={true}
                  isLocked={isInstLocked}
                  ampIndex={globalIdx}
                  cableLengths={cableLengths}
                  onCableLengthChange={globalIdx !== undefined ? (outputIndex, meters) => onCableLengthChange?.(globalIdx, outputIndex, meters) : undefined}
                />
              );
            });
          })()}

          {/* Empty rack slots */}
          {(() => {
            // In rack distribute mode, empty virtual amps are filtered from renderList
            const usedCount = rackDistributeMode
              ? transformedInstances.filter(inst => inst.totalEnclosures > 0).length
              : instances.length;
            const slotsToShow = RACK_SLOTS - usedCount;
            if (slotsToShow <= 0) return null;
            return Array.from({ length: slotsToShow });
          })()?.map((_, i) => {
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

function AmpCard({ instance: rawInstance, salesMode = false, cableGaugeMm2, useFeet, onAdjustEnclosure, packed, spread, onTogglePacked, onToggleSpread, isLocked = false, onLock, onUnlock, ampNumber, ampIndex, cableLengths, onCableLengthChange, hidePackToggle = false, isInRack = false }: { instance: AmpInstance; salesMode?: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; packed: boolean; spread: boolean; onTogglePacked: () => void; onToggleSpread: () => void; isLocked?: boolean; onLock?: () => void; onUnlock?: () => void; ampNumber?: number; ampIndex?: number; cableLengths?: Record<string, number>; onCableLengthChange?: (outputIndex: number, lengthMeters: number) => void; hidePackToggle?: boolean; isInRack?: boolean }) {
  // Compute the repacked/spread instance based on mode
  const instance = useMemo(() => {
    if (packed && spread) {
      // Prioritize Channels: pack first, then spread
      return spreadAmpInstance(repackAmpInstance(rawInstance));
    } else if (packed) {
      return repackAmpInstance(rawInstance);
    }
    return rawInstance;
  }, [packed, spread, rawInstance]);

  // Stable key prefix for cable lengths — locked amps use ID, unlocked use positional index
  const cableKeyPrefix = isLocked ? instance.id : (ampIndex !== undefined ? String(ampIndex) : instance.id);

  // Max cable length across all outputs (for combined chain displays)
  const ampMaxCableLength = Math.max(0, ...instance.outputs.map(o => cableLengths?.[`${cableKeyPrefix}:${o.outputIndex}`] ?? 0));

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
  const showPackToggle = rawInstance.totalEnclosures > 1 && !salesMode && !hidePackToggle && !isInRack;

  // NL8 is now always shown in CableChain for LA12X, no separate amp-level display needed
  const showAmpNL8 = false;
  const connectorClickBack: (() => void) | undefined = undefined;

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

      // Subwoofers (signal_channels = ["SB"]) always default to input "A"
      const isSub = output.enclosures[0]?.enclosure.signal_channels.length === 1 &&
                    output.enclosures[0]?.enclosure.signal_channels[0] === "SB";
      if (isSub) {
        initial[output.outputIndex] = "A";
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
                style={{ backgroundColor: 'rgba(181, 158, 95, 0.2)', color: document.documentElement.classList.contains('dark') ? '#b59e5f' : '#7A6B3A' }}
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
              <button
                onClick={onToggleSpread}
                className={`ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  spread
                    ? "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300 dark:hover:bg-green-900/60"
                    : "bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:hover:bg-purple-900/60"
                }`}
                title={spread ? "Switch to packed mode (stack like enclosures together)" : "Switch to spread mode (1 enclosure per channel)"}
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  {spread ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  )}
                </svg>
                {spread ? "Prioritize Channels" : "Packed"}
              </button>
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
                  showCableChain={!showAmpNL8}
                  onConnectorClick={connectorClickBack}
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
                showCableChain={!showAmpNL8}
                onConnectorClick={connectorClickBack}
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
                        showCableChain={!showAmpNL8}
                        onConnectorClick={connectorClickBack}
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
                        showCableChain={!showAmpNL8}
                        onConnectorClick={connectorClickBack}
                      />
                    );
                  }
                }

                return elements;
              })()}
            </div>
          )}
          {/* Combined PA-COM output — shown below output cards for PA-COM enclosures */}
          <div className="my-2 flex justify-center" style={{ zoom: 2 }}>
            <CombinedPACOMChain instance={instance} cableLengthMeters={ampMaxCableLength} useFeet={useFeet} />
          </div>
          {/* Combined NL8 output — shown when amp is in a LA-RAK */}
          {isInRack && (
            <div className="my-2 flex justify-center">
              <CombinedNL8Chain instance={instance} cableLengthMeters={ampMaxCableLength} useFeet={useFeet} />
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
function ZoneSolutionSection({ solution, salesMode, rackMode, cableGaugeMm2, useFeet, onAdjustEnclosure, lockedAmpIds, onLockAmpInstance, onLockRack, onUnlockAmpInstance, onCombineLockedRacks, rackNameMap: externalRackNameMap, onRackNameChange: externalOnRackNameChange, perOutputMap, hintsEnabled = false }: { solution: SolverSolution; salesMode: boolean; rackMode: boolean; cableGaugeMm2: number; useFeet: boolean; onAdjustEnclosure?: (enclosureName: string, delta: number) => void; lockedAmpIds?: Set<string>; onLockAmpInstance?: (ampInstance: AmpInstance) => void; onLockRack?: (ampInstances: AmpInstance[]) => void; onUnlockAmpInstance?: (ampInstanceId: string) => void; onCombineLockedRacks?: (ampIds: string[]) => void; rackNameMap?: Record<string, string>; onRackNameChange?: (rackKey: string, name: string) => void; perOutputMap?: Record<string, number>; hintsEnabled?: boolean }) {
  // Track packed/spread state per amp index (independent per amp)
  const [packedMap, setPackedMap] = useState<Record<number, boolean>>({});
  const [spreadMap, setSpreadMap] = useState<Record<number, boolean>>({});

  // Rack-level distribution mode: "spread" (default) = rack prioritize channels, "packed" = rack packed
  const [rackModeMap, setRackModeMap] = useState<Record<number, "spread" | "packed">>({});

  const handleRackToggle = (rackIdx: number) => {
    setRackModeMap(prev => {
      const current = prev[rackIdx] ?? "spread";
      return { ...prev, [rackIdx]: current === "spread" ? "packed" : "spread" };
    });
  };

  // Custom rack names — use external state if provided, otherwise local fallback
  const [localRackNameMap, setLocalRackNameMap] = useState<Record<string, string>>({});
  const rackNameMap = externalRackNameMap ?? localRackNameMap;
  const handleRackNameChange = externalOnRackNameChange ?? ((rackKey: string, name: string) => {
    setLocalRackNameMap(prev => ({ ...prev, [rackKey]: name }));
  });

  // Per-output cable length in meters, keyed by "ampIndex:outputIndex" or "ampId:outputIndex"
  // Unlocked amps use positional index (survives solver re-runs), locked amps use stable ID
  const [cableLengths, setCableLengths] = useState<Record<string, number>>({});
  const handleCableLengthChange = (ampIndex: number, outputIndex: number, meters: number) => {
    setCableLengths(prev => ({ ...prev, [`${ampIndex}:${outputIndex}`]: meters }));
  };

  // Wrap lock callback to migrate cable lengths from positional key to ID-based key
  const handleLockWithCableMigration = onLockAmpInstance ? (ampInstance: AmpInstance, ampIndex: number) => {
    // Copy cable lengths from positional "ampIndex:outputIndex" to "ampId:outputIndex"
    setCableLengths(prev => {
      const updated = { ...prev };
      for (const output of ampInstance.outputs) {
        const positionalKey = `${ampIndex}:${output.outputIndex}`;
        const idKey = `${ampInstance.id}:${output.outputIndex}`;
        if (updated[positionalKey] !== undefined && updated[positionalKey] > 0) {
          updated[idKey] = updated[positionalKey];
          delete updated[positionalKey];
        }
      }
      return updated;
    });
    onLockAmpInstance(ampInstance);
  } : undefined;

  // Batch lock handler for entire rack — single state update to avoid partial locks
  const handleLockRackWithCableMigration = onLockRack ? (ampInstances: AmpInstance[], ampIndices: number[]) => {
    // Migrate cable lengths for all amps in one setCableLengths call
    setCableLengths(prev => {
      const updated = { ...prev };
      for (let i = 0; i < ampInstances.length; i++) {
        const ampInstance = ampInstances[i];
        const ampIndex = ampIndices[i];
        for (const output of ampInstance.outputs) {
          const positionalKey = `${ampIndex}:${output.outputIndex}`;
          const idKey = `${ampInstance.id}:${output.outputIndex}`;
          if (updated[positionalKey] !== undefined && updated[positionalKey] > 0) {
            updated[idKey] = updated[positionalKey];
            delete updated[positionalKey];
          }
        }
      }
      return updated;
    });
    onLockRack(ampInstances);
  } : undefined;

  // Cable length change handler for locked amps — writes to ID-based keys
  const handleLockedCableLengthChange = (ampId: string, outputIndex: number, meters: number) => {
    setCableLengths(prev => ({ ...prev, [`${ampId}:${outputIndex}`]: meters }));
  };

  // Draggable column divider — split percentage between unlocked (left) and locked (right)
  const [splitPercent, setSplitPercent] = useState(50);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  // Font bonus for locked column text: 0px at default (50%) → 4px at max width (80%)
  const lockedFontBonus = Math.max(0, Math.min(4, ((50 - splitPercent) / 30) * 4));

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = moveEvent.clientX - rect.left;
      const percent = (x / rect.width) * 100;
      setSplitPercent(Math.max(20, Math.min(80, percent)));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
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
        // New amp - copy settings from previous amp (or default to true for first)
        const prevPacked = i > 0 ? (packedMap[i - 1] ?? true) : true;
        const prevSpread = i > 0 ? (spreadMap[i - 1] ?? true) : true;
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
    setSpreadMap(prev => ({ ...prev, [index]: !(prev[index] ?? true) }));
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

  // Detect if any locked amps exist (drives 2-column layout)
  const hasLockedRacks = !salesMode && solution.ampInstances.some(inst =>
    lockedAmpIds?.has(inst.id) ?? false
  );

  // Error banners — rendered in the unlocked column
  const errorBanners = (
    <>
      {solution.errorMessage && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <p className="text-sm text-amber-700 dark:text-amber-400">{solution.errorMessage}</p>
          </div>
        </div>
      )}
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
    </>
  );

  // Compute locked/unlocked column content based on mode
  let lockedColumnContent: React.ReactNode = null;
  let unlockedColumnContent: React.ReactNode = null;

  if (salesMode) {
    // Sales mode — everything goes to unlocked column (no locked racks)
    unlockedColumnContent = (() => {
      const grouped = new Map<string, AmpInstance[]>();
      for (const instance of solution.ampInstances) {
        const key = instance.ampConfig.key;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(instance);
      }
      const hasLockedRackLa12x = grouped.has("LA12X") && grouped.get("LA12X")!.some(inst => lockedAmpIds?.has(inst.id) && inst.rackGroupId);
      if ((rackMode || hasLockedRackLa12x) && grouped.has("LA12X")) {
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
      return <>{Array.from(grouped.entries()).map(([key, instances]) => (
        <GroupedAmpCard key={key} instances={instances} />
      ))}</>;
    })();
  } else if (rackMode) {
    // Rack mode — split locked racks from unlocked
    const result = (() => {
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
      const lockedLa12x = la12xEntries.filter(e => lockedAmpIds?.has(e.instance.id));
      const unlockedLa12x = la12xEntries.filter(e => !(lockedAmpIds?.has(e.instance.id)));

      const lockedRackGroups = new Map<string, { instance: AmpInstance; globalIndex: number }[]>();
      for (const entry of lockedLa12x) {
        const groupId = entry.instance.rackGroupId ?? entry.instance.id;
        if (!lockedRackGroups.has(groupId)) lockedRackGroups.set(groupId, []);
        lockedRackGroups.get(groupId)!.push(entry);
      }
      const lockedRacks = Array.from(lockedRackGroups.values());
      const canCombineLockedRacks = lockedRacks.length > 1 && lockedLa12x.length <= RACK_SIZE;

      const unlockedRacks: { instance: AmpInstance; globalIndex: number }[][] = [];
      let preSpread = false;
      {
        const allSpread = Object.keys(rackModeMap).length === 0 ||
          Object.values(rackModeMap).every(m => m === "spread");
        if (allSpread && unlockedLa12x.length > 0) {
          const ampConfig = unlockedLa12x[0].instance.ampConfig;
          let totalGroupsNeeded = 0;
          let firstEnclosure: Enclosure | undefined;
          for (const entry of unlockedLa12x) {
            for (const output of entry.instance.outputs) {
              for (const enc of output.enclosures) {
                if (enc.count > 0) {
                  if (!firstEnclosure) firstEnclosure = enc.enclosure;
                  const cpu = getChannelsPerUnit(enc.enclosure, ampConfig.key);
                  const perOut = perOutputMap?.[enc.enclosure.enclosure] ?? 1;
                  if (cpu > 1) {
                    if (output.outputIndex % cpu === 0) totalGroupsNeeded += Math.ceil(enc.count / perOut);
                  } else {
                    totalGroupsNeeded += Math.ceil(enc.count / perOut);
                  }
                }
              }
            }
          }
          const cpu = firstEnclosure ? getChannelsPerUnit(firstEnclosure, ampConfig.key) : 1;
          const groupsPerAmp = Math.max(1, Math.floor(ampConfig.outputs / Math.max(1, cpu)));
          const ampsNeeded = Math.max(unlockedLa12x.length, Math.ceil(totalGroupsNeeded / groupsPerAmp));
          if (ampsNeeded > unlockedLa12x.length) {
            preSpread = true;
            const padded: { instance: AmpInstance; globalIndex: number }[] = [...unlockedLa12x];
            for (let i = unlockedLa12x.length; i < ampsNeeded; i++) {
              padded.push({
                instance: {
                  id: `spread-virtual-${i}`,
                  ampConfig,
                  outputs: Array.from({ length: ampConfig.outputs }, (_, oi) => ({
                    outputIndex: oi, enclosures: [], totalEnclosures: 0, impedanceOhms: Infinity,
                  })),
                  totalEnclosures: 0, loadPercent: 0,
                },
                globalIndex: -1,
              });
            }
            const allInstances = padded.map(e => e.instance);
            const spread = spreadRackInstances(repackRackInstances(allInstances), perOutputMap);
            const spreadEntries = padded
              .map((e, i) => ({ ...e, instance: spread[i] }))
              .filter(e => e.instance.totalEnclosures > 0);
            for (let r = 0; r < Math.ceil(spreadEntries.length / RACK_SIZE); r++) {
              unlockedRacks.push(spreadEntries.slice(r * RACK_SIZE, (r + 1) * RACK_SIZE));
            }
          } else {
            for (let r = 0; r < Math.ceil(unlockedLa12x.length / RACK_SIZE); r++) {
              unlockedRacks.push(unlockedLa12x.slice(r * RACK_SIZE, (r + 1) * RACK_SIZE));
            }
          }
        } else {
          for (let r = 0; r < Math.ceil(unlockedLa12x.length / RACK_SIZE); r++) {
            unlockedRacks.push(unlockedLa12x.slice(r * RACK_SIZE, (r + 1) * RACK_SIZE));
          }
        }
      }

      // Split non-LA12X (other) amps into locked and unlocked
      const lockedOtherEntries = otherEntries.filter(e => lockedAmpIds?.has(e.instance.id));
      const unlockedOtherEntries = otherEntries.filter(e => !(lockedAmpIds?.has(e.instance.id)));

      const otherAmpNumbers = new Map<number, number>();
      otherEntries.forEach((e, idx) => otherAmpNumbers.set(e.globalIndex, idx + 1));

      // Compute non-conflicting rack names
      const lockedRackDisplayNames: string[] = [];
      const takenNumbers = new Set<number>();
      for (let i = 0; i < lockedRacks.length; i++) {
        const rackKey = lockedRacks[i][0]?.instance.rackGroupId ?? `locked-${i}`;
        const customName = rackNameMap[rackKey];
        if (customName) {
          lockedRackDisplayNames.push(customName);
          const match = customName.match(/^LA-RAK #(\d+)$/) || customName.match(/^(\d+) RAK$/);
          if (match) takenNumbers.add(parseInt(match[1]));
        } else {
          lockedRackDisplayNames.push("");
        }
      }
      let nextNum = 1;
      const getNextAvailableNum = () => {
        while (takenNumbers.has(nextNum)) nextNum++;
        const num = nextNum; takenNumbers.add(num); nextNum++;
        return num;
      };
      for (let i = 0; i < lockedRackDisplayNames.length; i++) {
        if (!lockedRackDisplayNames[i]) lockedRackDisplayNames[i] = `LA-RAK #${getNextAvailableNum()}`;
      }
      const pendingUnlockName = rackNameMap?.["pending-unlock"];
      const takenRakNumbers = new Set<number>();
      for (const name of lockedRackDisplayNames) {
        const match = name.match(/^(\d+) RAK$/) || name.match(/^LA-RAK #(\d+)$/);
        if (match) takenRakNumbers.add(parseInt(match[1]));
      }
      if (pendingUnlockName) {
        const match = pendingUnlockName.match(/^(\d+) RAK$/) || pendingUnlockName.match(/^LA-RAK #(\d+)$/);
        if (match) takenRakNumbers.add(parseInt(match[1]));
      }
      const unlockedRackDisplayNames: string[] = [];
      let nextRakNum = 1;
      let pendingConsumed = false;
      for (let i = 0; i < unlockedRacks.length; i++) {
        if (!pendingConsumed && pendingUnlockName) {
          unlockedRackDisplayNames.push(pendingUnlockName); pendingConsumed = true;
        } else {
          while (takenRakNumbers.has(nextRakNum)) nextRakNum++;
          unlockedRackDisplayNames.push(`${nextRakNum} RAK`); nextRakNum++;
        }
      }

      // Build locked column content (racks + individually locked amps)
      const hasLockedContent = lockedRacks.length > 0 || lockedOtherEntries.length > 0;
      const locked = hasLockedContent ? (
        <div className="space-y-4">
          {lockedRacks.map((rackEntries, rackIdx) => {
            const isAnimating = rackEntries.some(e => animatingLockIds.has(e.instance.id));
            // Map globalIndex → instance.id for cable length writes on locked racks
            const idByGlobalIdx = new Map(rackEntries.map(e => [e.globalIndex, e.instance.id]));
            const lockedCableLengthChange = (ampIdx: number, outputIndex: number, meters: number) => {
              const key = idByGlobalIdx.get(ampIdx) ?? String(ampIdx);
              setCableLengths(prev => ({ ...prev, [`${key}:${outputIndex}`]: meters }));
            };
            return (
              <div key={`locked-rack-${rackIdx}`} className={isAnimating ? 'lock-slide-up' : ''}>
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
                    const allLockedLa12xIds = lockedLa12x.map(e => e.instance.id);
                    onCombineLockedRacks?.(allLockedLa12xIds);
                  }}
                  cableLengths={cableLengths}
                  onCableLengthChange={lockedCableLengthChange}
                  rackDistributeMode={rackModeMap[rackIdx] ?? "spread"}
                  onRackToggle={() => handleRackToggle(rackIdx)}
                  rackName={lockedRackDisplayNames[rackIdx]}
                  onRackNameChange={handleRackNameChange}
                  perOutputMap={perOutputMap}
                />
              </div>
            );
          })}
          {lockedOtherEntries.map(({ instance, globalIndex }) => {
            const isAnimating = animatingLockIds.has(instance.id);
            return (
              <div key={instance.id} className={isAnimating ? 'lock-slide-up' : ''}>
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
                  ampNumber={otherAmpNumbers.get(globalIndex) ?? 1}
                  cableLengths={cableLengths}
                  onCableLengthChange={(outputIndex, meters) => handleLockedCableLengthChange(instance.id, outputIndex, meters)}
                />
              </div>
            );
          })}
        </div>
      ) : null;

      // Build unlocked column content
      const unlocked = (
        <>
          {unlockedRacks.map((rackEntries, rackIdx) => {
            // Wrap lock callback to migrate cable lengths for each amp in the rack
            const rackLockHandler = handleLockWithCableMigration ? (ampInstance: AmpInstance) => {
              const entry = rackEntries.find(e => e.instance.id === ampInstance.id);
              const idx = entry?.globalIndex ?? rackEntries[0]?.globalIndex ?? 0;
              handleLockWithCableMigration(ampInstance, idx);
            } : onLockAmpInstance;
            // Batch lock handler — locks all rack amps in a single state update
            const rackBatchLockHandler = handleLockRackWithCableMigration ? (ampInstances: AmpInstance[]) => {
              const indices = ampInstances.map(inst => {
                const entry = rackEntries.find(e => e.instance.id === inst.id);
                return entry?.globalIndex ?? rackEntries[0]?.globalIndex ?? 0;
              });
              handleLockRackWithCableMigration(ampInstances, indices);
            } : onLockRack;
            return (
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
                onLockAmpInstance={rackLockHandler}
                onLockRack={rackBatchLockHandler}
                onUnlockAmpInstance={onUnlockAmpInstance}
                globalIndices={rackEntries.map(e => e.globalIndex)}
                cableLengths={cableLengths}
                onCableLengthChange={handleCableLengthChange}
                rackDistributeMode={preSpread ? undefined : (rackModeMap[lockedRacks.length + rackIdx] ?? "spread")}
                onRackToggle={() => handleRackToggle(lockedRacks.length + rackIdx)}
                rackName={unlockedRackDisplayNames[rackIdx]}
                onRackNameChange={handleRackNameChange}
                perOutputMap={perOutputMap}
              />
            );
          })}
          {unlockedOtherEntries.map(({ instance, globalIndex }) => (
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
              onLock={() => handleLockWithCableMigration?.(instance, globalIndex)}
              onUnlock={() => onUnlockAmpInstance?.(instance.id)}
              ampNumber={otherAmpNumbers.get(globalIndex) ?? 1}
              ampIndex={globalIndex}
              cableLengths={cableLengths}
              onCableLengthChange={(outputIndex, meters) => handleCableLengthChange(globalIndex, outputIndex, meters)}
            />
          ))}
        </>
      );

      return { locked, unlocked };
    })();
    lockedColumnContent = result.locked;
    unlockedColumnContent = result.unlocked;
  } else {
    // Non-rack mode — split locked rack cards from regular entries
    const result = (() => {
      const entries = solution.ampInstances.map((instance, index) => ({ instance, index }));
      const locked = entries.filter(e => lockedAmpIds?.has(e.instance.id));
      const unlocked = entries.filter(e => !(lockedAmpIds?.has(e.instance.id)));

      const lockedRackLa12x = locked.filter(e => e.instance.ampConfig.key === "LA12X" && e.instance.rackGroupId);
      const lockedNonRack = locked.filter(e => !(e.instance.ampConfig.key === "LA12X" && e.instance.rackGroupId));

      const lockedRackGroups = new Map<string, { instance: AmpInstance; index: number }[]>();
      for (const entry of lockedRackLa12x) {
        const groupId = entry.instance.rackGroupId!;
        if (!lockedRackGroups.has(groupId)) lockedRackGroups.set(groupId, []);
        lockedRackGroups.get(groupId)!.push(entry);
      }
      const lockedRacks = Array.from(lockedRackGroups.values());

      const regularEntries = unlocked.sort((a, b) => a.index - b.index);
      const regularAmpNumbers = new Map<number, number>();
      regularEntries.forEach((e, idx) => regularAmpNumbers.set(e.index, idx + 1));

      const lockedNonRackAmpNumbers = new Map<number, number>();
      lockedNonRack.forEach((e, idx) => lockedNonRackAmpNumbers.set(e.index, idx + 1));

      const hasLockedContent = lockedRacks.length > 0 || lockedNonRack.length > 0;
      const lockedContent = hasLockedContent ? (
        <div className="space-y-4">
          {lockedRacks.map((rackEntries, rackIdx) => {
            const isAnimating = rackEntries.some(e => animatingLockIds.has(e.instance.id));
            const rackKey = rackEntries[0]?.instance.rackGroupId ?? `locked-${rackIdx}`;
            const customName = rackNameMap[rackKey];
            const displayName = customName || `LA-RAK #${rackIdx + 1}`;
            const idByIdx = new Map(rackEntries.map(e => [e.index, e.instance.id]));
            const lockedCableLengthChange = (ampIdx: number, outputIndex: number, meters: number) => {
              const key = idByIdx.get(ampIdx) ?? String(ampIdx);
              setCableLengths(prev => ({ ...prev, [`${key}:${outputIndex}`]: meters }));
            };
            return (
              <div key={`locked-rack-${rackIdx}`} className={isAnimating ? 'lock-slide-up' : ''}>
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
                  globalIndices={rackEntries.map(e => e.index)}
                  cableLengths={cableLengths}
                  onCableLengthChange={lockedCableLengthChange}
                  rackDistributeMode="spread"
                  rackName={displayName}
                  onRackNameChange={handleRackNameChange}
                  perOutputMap={perOutputMap}
                  fontBonus={lockedFontBonus}
                />
              </div>
            );
          })}
          {lockedNonRack.map(({ instance, index }) => {
            const isAnimating = animatingLockIds.has(instance.id);
            return (
              <div key={instance.id} className={isAnimating ? 'lock-slide-up' : ''}>
                <AmpCard
                  instance={instance}
                  salesMode={salesMode}
                  cableGaugeMm2={cableGaugeMm2}
                  useFeet={useFeet}
                  onAdjustEnclosure={onAdjustEnclosure}
                  packed={packedMap[index] ?? false}
                  spread={spreadMap[index] ?? false}
                  onTogglePacked={() => handleTogglePacked(index)}
                  onToggleSpread={() => handleToggleSpread(index)}
                  isLocked={true}
                  onLock={() => onLockAmpInstance?.(instance)}
                  onUnlock={() => onUnlockAmpInstance?.(instance.id)}
                  ampNumber={lockedNonRackAmpNumbers.get(index) ?? 1}
                  cableLengths={cableLengths}
                  onCableLengthChange={(outputIndex, meters) => handleLockedCableLengthChange(instance.id, outputIndex, meters)}
                />
              </div>
            );
          })}
        </div>
      ) : null;

      const unlockedContent = (
        <>
          {regularEntries.map(({ instance, index }) => (
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
              isLocked={false}
              onLock={() => handleLockWithCableMigration?.(instance, index)}
              onUnlock={() => onUnlockAmpInstance?.(instance.id)}
              ampNumber={regularAmpNumbers.get(index) ?? 1}
              ampIndex={index}
              cableLengths={cableLengths}
              onCableLengthChange={(outputIndex, meters) => handleCableLengthChange(index, outputIndex, meters)}
            />
          ))}
        </>
      );

      return { locked: lockedContent, unlocked: unlockedContent };
    })();
    lockedColumnContent = result.locked;
    unlockedColumnContent = result.unlocked;
  }

  const showSplit = hasLockedRacks && lockedColumnContent;

  return (
    <div className="flex h-full" ref={splitContainerRef}>
      {/* Unlocked amps column — independently scrollable */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: showSplit ? `${splitPercent}%` : '100%' }}
      >
        <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 px-6 py-2.5 dark:border-neutral-800 dark:bg-transparent">
          <span className="text-sm font-medium text-gray-700 dark:text-neutral-300">Amplification Calculator</span>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <div className="space-y-6">
            {hintsEnabled && !hasLockedRacks && solution.ampInstances.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-400">
                <svg className="h-4 w-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span>Lock an amplifier by clicking the <svg className="inline h-3.5 w-3.5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg> icon when finished configuring.</span>
              </div>
            )}
            {errorBanners}
            <div className="space-y-4">
              {unlockedColumnContent}
            </div>
          </div>
        </div>
      </div>
      {/* Draggable column divider */}
      {showSplit && (
        <div
          onMouseDown={handleDividerMouseDown}
          className="w-1 flex-shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 dark:bg-neutral-700 dark:hover:bg-blue-500 dark:active:bg-blue-400 transition-colors"
        />
      )}
      {/* Locked racks column — independently scrollable (right side) */}
      {showSplit && (
        <div
          className="flex flex-col overflow-hidden"
          style={{ width: `${100 - splitPercent}%` }}
        >
          <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 px-6 py-2.5 dark:border-neutral-800 dark:bg-transparent">
            <span className="text-sm font-medium text-gray-700 dark:text-neutral-300">Locked Amps</span>
          </div>
          <div className="flex-1 overflow-auto p-6">
            {lockedColumnContent}
          </div>
        </div>
      )}
    </div>
  );
}

export function RecommendedConfig({ solution, rackMode, lockedAmpIds, perOutputMap, hasErrors }: {
  solution: SolverSolution;
  rackMode: boolean;
  lockedAmpIds?: Set<string>;
  perOutputMap?: Record<string, number>;
  hasErrors: boolean;
}) {
  const RACK_SIZE = 3;
  let effectiveAmpCount = solution.summary.totalAmplifiers;
  let effectiveLa12xCount = solution.ampInstances.filter(inst => inst.ampConfig.key === "LA12X").length;

  if (rackMode && perOutputMap && Object.keys(perOutputMap).length > 0) {
    const lockedCount = solution.ampInstances.filter(inst => lockedAmpIds?.has(inst.id)).length;
    const unlockedLa12x = solution.ampInstances.filter(
      inst => inst.ampConfig.key === "LA12X" && !(lockedAmpIds?.has(inst.id))
    );
    const lockedLa12x = solution.ampInstances.filter(
      inst => inst.ampConfig.key === "LA12X" && lockedAmpIds?.has(inst.id)
    );
    const otherUnlocked = solution.ampInstances.filter(
      inst => inst.ampConfig.key !== "LA12X" && !(lockedAmpIds?.has(inst.id))
    );

    if (unlockedLa12x.length > 0) {
      const ampConfig = unlockedLa12x[0].ampConfig;
      const totalPerType = new Map<string, { enclosure: Enclosure; total: number }>();
      for (const inst of unlockedLa12x) {
        for (const output of inst.outputs) {
          for (const enc of output.enclosures) {
            if (enc.count > 0) {
              const cpu = getChannelsPerUnit(enc.enclosure, ampConfig.key);
              if (cpu > 1) {
                if (output.outputIndex % cpu === 0) {
                  const key = enc.enclosure.enclosure;
                  const existing = totalPerType.get(key);
                  totalPerType.set(key, { enclosure: enc.enclosure, total: (existing?.total ?? 0) + enc.count });
                }
              } else {
                const key = enc.enclosure.enclosure;
                const existing = totalPerType.get(key);
                totalPerType.set(key, { enclosure: enc.enclosure, total: (existing?.total ?? 0) + enc.count });
              }
            }
          }
        }
      }

      let totalOutputsNeeded = 0;
      for (const [, { enclosure, total }] of totalPerType) {
        const limits = enclosure.max_enclosures?.[ampConfig.key];
        const defaultPerOutput = limits?.per_output ?? 1;
        const perOut = perOutputMap[enclosure.enclosure] ?? defaultPerOutput;
        const cpu = getChannelsPerUnit(enclosure, ampConfig.key);
        totalOutputsNeeded += Math.ceil(total / perOut) * Math.max(1, cpu);
      }
      const ampsNeeded = Math.max(unlockedLa12x.length, Math.ceil(totalOutputsNeeded / ampConfig.outputs));

      effectiveAmpCount = lockedCount + ampsNeeded + otherUnlocked.length;
      effectiveLa12xCount = lockedLa12x.length + ampsNeeded;
    }
  } else if (rackMode) {
    const unlockedLa12x = solution.ampInstances.filter(
      inst => inst.ampConfig.key === "LA12X" && !(lockedAmpIds?.has(inst.id))
    );
    const lockedLa12x = solution.ampInstances.filter(
      inst => inst.ampConfig.key === "LA12X" && lockedAmpIds?.has(inst.id)
    );
    if (unlockedLa12x.length > 0) {
      const ampConfig = unlockedLa12x[0].ampConfig;
      // Count total enclosures per type and compute outputs needed based on per_output limits
      const totalPerType = new Map<string, { enclosure: Enclosure; total: number }>();
      for (const inst of unlockedLa12x) {
        for (const output of inst.outputs) {
          for (const enc of output.enclosures) {
            if (enc.count > 0) {
              const cpu = getChannelsPerUnit(enc.enclosure, ampConfig.key);
              if (cpu > 1) {
                if (output.outputIndex % cpu === 0) {
                  const key = enc.enclosure.enclosure;
                  const existing = totalPerType.get(key);
                  totalPerType.set(key, { enclosure: enc.enclosure, total: (existing?.total ?? 0) + enc.count });
                }
              } else {
                const key = enc.enclosure.enclosure;
                const existing = totalPerType.get(key);
                totalPerType.set(key, { enclosure: enc.enclosure, total: (existing?.total ?? 0) + enc.count });
              }
            }
          }
        }
      }
      let totalOutputsNeeded = 0;
      for (const [, { enclosure, total }] of totalPerType) {
        const limits = enclosure.max_enclosures?.[ampConfig.key];
        const perOutput = limits?.per_output ?? 1;
        const cpu = getChannelsPerUnit(enclosure, ampConfig.key);
        totalOutputsNeeded += Math.ceil(total / perOutput) * Math.max(1, cpu);
      }
      const ampsNeeded = Math.max(unlockedLa12x.length, Math.ceil(totalOutputsNeeded / ampConfig.outputs));
      effectiveLa12xCount = lockedLa12x.length + ampsNeeded;
      effectiveAmpCount = solution.ampInstances.filter(inst => lockedAmpIds?.has(inst.id)).length
        + ampsNeeded
        + solution.ampInstances.filter(inst => inst.ampConfig.key !== "LA12X" && !(lockedAmpIds?.has(inst.id))).length;
    }
  }

  const emptyLockedCount = solution.ampInstances.filter(
    inst => lockedAmpIds?.has(inst.id) && inst.totalEnclosures === 0
  ).length;
  effectiveAmpCount -= emptyLockedCount;
  effectiveLa12xCount -= solution.ampInstances.filter(
    inst => inst.ampConfig.key === "LA12X" && lockedAmpIds?.has(inst.id) && inst.totalEnclosures === 0
  ).length;

  const lockedLa12xForRaks = solution.ampInstances.filter(
    inst => inst.ampConfig.key === "LA12X" && lockedAmpIds?.has(inst.id) && inst.totalEnclosures > 0
  );
  const lockedRackGroupIds = new Set(
    solution.ampInstances
      .filter(inst => inst.ampConfig.key === "LA12X" && lockedAmpIds?.has(inst.id))
      .map(inst => inst.rackGroupId ?? inst.id)
  );
  const unlockedLa12xForRaks = effectiveLa12xCount - lockedLa12xForRaks.length;
  const totalRaks = rackMode
    ? lockedRackGroupIds.size + Math.ceil(Math.max(0, unlockedLa12xForRaks) / RACK_SIZE)
    : 0;
  const colorBase = hasErrors ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500";
  const colorBold = hasErrors ? "text-amber-900 dark:text-amber-400" : "text-green-900 dark:text-green-400";

  return (
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
          {rackMode && totalRaks > 0 && (
            <span className={colorBase}>
              <span className={`font-bold text-base ${colorBold}`}>{totalRaks}</span> RAK{totalRaks !== 1 ? "s" : ""}
            </span>
          )}
          <span className={colorBase}>
            <span className={`font-bold text-base ${colorBold}`}>{effectiveAmpCount}</span> amp{effectiveAmpCount !== 1 ? "s" : ""}
          </span>
          <span className={colorBase}>
            <span className={`font-bold text-base ${colorBold}`}>{solution.summary.totalEnclosuresAllocated}</span> encl.
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
  );
}

export default function SolverResults({ zoneSolutions, activeZoneId, salesMode = false, rackMode = false, cableGaugeMm2 = 2.5, useFeet = true, onAdjustEnclosure, onLockAmpInstance, onLockRack, onUnlockAmpInstance, onCombineLockedRacks, onMoveEnclosure, rackNameMap: externalRackNameMap, onRackNameChange: externalOnRackNameChange, perOutputMap, hintsEnabled = false }: SolverResultsProps) {
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
      <div className="h-full">
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
          onLockRack={onLockRack}
          onUnlockAmpInstance={onUnlockAmpInstance}
          onCombineLockedRacks={onCombineLockedRacks}
          rackNameMap={externalRackNameMap}
          onRackNameChange={externalOnRackNameChange}
          perOutputMap={perOutputMap}
          hintsEnabled={hintsEnabled}
        />
      </div>
    </EnclosureDragDropProvider>
  );
}
