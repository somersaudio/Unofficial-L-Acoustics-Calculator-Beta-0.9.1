/**
 * Pure SVG chart showing frequency-dependent cable loss per amp output.
 * Renders one curve per output that has a cable length > 0.
 */

import React, { useMemo, useState, useCallback } from "react"; // eslint-disable-line
import {
  generateImpedanceCurve,
  calculateFrequencyDependentLoss,
  parseZmaFile,
  setImpedanceCurveOverride,
  hasImpedanceCurveOverride,
} from "../utils/impedanceModel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OutputData {
  outputIndex: number;
  enclosureName: string;
  nominalImpedance: number;
  signalChannels: string[];
  cableLengthMeters: number;
  impedanceOhms: number;
}

interface CableLossChartProps {
  outputs: OutputData[];
  gaugeMm2: number;
  useFeet: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_WIDTH = 460;
const CHART_HEIGHT = 130;
const PADDING = { top: 12, right: 50, bottom: 28, left: 36 };
const PLOT_W = CHART_WIDTH - PADDING.left - PADDING.right;
const PLOT_H = CHART_HEIGHT - PADDING.top - PADDING.bottom;

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS: Record<number, string> = {
  20: "20", 50: "50", 100: "100", 200: "200", 500: "500",
  1000: "1k", 2000: "2k", 5000: "5k", 10000: "10k", 20000: "20k",
};

// Output colors — Soft Tech palette (muted professional colors)
const OUTPUT_COLORS = [
  { stroke: "#4A9B9B", fill: "rgba(74, 155, 155, 0.12)" },     // Teal
  { stroke: "#8B7FB8", fill: "rgba(139, 127, 184, 0.12)" },   // Soft Purple
  { stroke: "#5DB572", fill: "rgba(93, 181, 114, 0.12)" },    // Emerald Green
  { stroke: "#B87F8B", fill: "rgba(184, 127, 139, 0.12)" },   // Dusty Rose
  { stroke: "#B89B7F", fill: "rgba(184, 155, 127, 0.12)" },   // Warm Sand
];

const OUTPUT_COLORS_DARK = [
  { stroke: "#5DBDBD", fill: "rgba(93, 189, 189, 0.15)" },    // Teal (bright)
  { stroke: "#A599D4", fill: "rgba(165, 153, 212, 0.15)" },   // Soft Purple (bright)
  { stroke: "#77D48F", fill: "rgba(119, 212, 143, 0.15)" },   // Emerald Green (bright)
  { stroke: "#D499A6", fill: "rgba(212, 153, 166, 0.15)" },   // Dusty Rose (bright)
  { stroke: "#D4B899", fill: "rgba(212, 184, 153, 0.15)" },   // Warm Sand (bright)
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freqToX(f: number): number {
  const logMin = Math.log10(FREQ_MIN);
  const logMax = Math.log10(FREQ_MAX);
  return PADDING.left + ((Math.log10(f) - logMin) / (logMax - logMin)) * PLOT_W;
}

function dbToY(db: number, dbMin: number): number {
  // 0 dB at top, dbMin at bottom
  return PADDING.top + ((-db) / (-dbMin)) * PLOT_H;
}

function formatDb(db: number): string {
  return db.toFixed(1);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CableLossChart({ outputs, gaugeMm2 }: CableLossChartProps) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [importKey, setImportKey] = useState(0); // force re-render after import

  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const colors = isDark ? OUTPUT_COLORS_DARK : OUTPUT_COLORS;

  // Calculate loss curves for each output with cable length > 0
  const curves = useMemo(() => {
    return outputs
      .filter(o => o.cableLengthMeters > 0 && o.impedanceOhms > 0 && o.impedanceOhms !== Infinity)
      .map((o) => {
        const impedanceCurve = generateImpedanceCurve(o.enclosureName, o.nominalImpedance, o.signalChannels);
        const lossCurve = calculateFrequencyDependentLoss(impedanceCurve, o.cableLengthMeters, gaugeMm2);
        return {
          outputIndex: o.outputIndex,
          enclosureName: o.enclosureName,
          lossCurve,
          color: colors[o.outputIndex % colors.length], // Use outputIndex for consistent color assignment
          hasOverride: hasImpedanceCurveOverride(o.enclosureName),
        };
      });
  }, [outputs, gaugeMm2, colors, importKey]);

  if (curves.length === 0) return null;

  // Find dB range — auto-scale Y axis
  let globalMinDb = 0;
  for (const curve of curves) {
    for (const pt of curve.lossCurve) {
      if (pt.lossDb < globalMinDb) globalMinDb = pt.lossDb;
    }
  }
  // Round down to next 0.5 dB and add padding
  const dbMin = Math.floor(globalMinDb * 2 - 1) / 2;
  const dbTicks: number[] = [];
  for (let db = 0; db >= dbMin; db -= 0.5) {
    dbTicks.push(Math.round(db * 10) / 10);
  }

  // Compute max frequency response deviation (spread) across all curves
  let maxSpread = 0;
  for (const curve of curves) {
    if (curve.lossCurve.length === 0) continue;
    let minLoss = 0, maxLoss = 0;
    for (const pt of curve.lossCurve) {
      if (pt.lossDb < minLoss) minLoss = pt.lossDb;
      if (pt.lossDb > maxLoss) maxLoss = pt.lossDb;
    }
    const spread = maxLoss - minLoss;
    if (spread > maxSpread) maxSpread = spread;
  }

  // Build SVG paths
  const curvePaths = curves.map(curve => {
    if (curve.lossCurve.length === 0) return { ...curve, linePath: "", fillPath: "" };

    const points = curve.lossCurve.map(pt => ({
      x: freqToX(pt.frequency),
      y: dbToY(pt.lossDb, dbMin),
    }));

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

    // Fill path: curve + close along top (0 dB line)
    const y0 = dbToY(0, dbMin);
    const fillPath = linePath +
      ` L ${points[points.length - 1].x.toFixed(1)} ${y0.toFixed(1)}` +
      ` L ${points[0].x.toFixed(1)} ${y0.toFixed(1)} Z`;

    return { ...curve, linePath, fillPath };
  });

  // Hover: find frequency at mouse X position
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHoverX(x);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverX(null);
  }, []);

  // Convert hover X to frequency
  const hoverFreq = hoverX !== null ? (() => {
    const logMin = Math.log10(FREQ_MIN);
    const logMax = Math.log10(FREQ_MAX);
    const t = (hoverX - PADDING.left) / PLOT_W;
    if (t < 0 || t > 1) return null;
    return Math.pow(10, logMin + t * (logMax - logMin));
  })() : null;

  // Get dB values at hover frequency for each curve
  const hoverValues = hoverFreq !== null ? curves.map(curve => {
    if (curve.lossCurve.length === 0) return null;
    // Find nearest point
    let closest = curve.lossCurve[0];
    let minDist = Math.abs(Math.log10(curve.lossCurve[0].frequency) - Math.log10(hoverFreq));
    for (const pt of curve.lossCurve) {
      const dist = Math.abs(Math.log10(pt.frequency) - Math.log10(hoverFreq));
      if (dist < minDist) { minDist = dist; closest = pt; }
    }
    return closest.lossDb;
  }) : null;

  // .zma import handler
  const handleZmaImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const enclosureName = outputs.find(o => o.cableLengthMeters > 0)?.enclosureName;
    if (!enclosureName) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = parseZmaFile(text);
      if (parsed) {
        setImpedanceCurveOverride(enclosureName, parsed);
        setImportKey(k => k + 1);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset for re-import
  }, [outputs]);

  const textColor = isDark ? "#a3a3a3" : "#6b7280";
  const gridColor = isDark ? "#333" : "#e5e7eb";
  const refLineColor = isDark ? "#555" : "#d1d5db";

  return (
    <div className="mt-3 border-t border-gray-200 pt-2 dark:border-neutral-700">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium text-gray-500 dark:text-neutral-500">
          Cable Loss vs Frequency
          {maxSpread > 0 && (
            <span className={`ml-2 ${maxSpread > 0.5 ? "text-amber-600 dark:text-amber-500" : "text-gray-400 dark:text-neutral-500"}`}>
              ({formatDb(maxSpread)} dB spread)
            </span>
          )}
        </span>
        <label className="text-[9px] text-gray-400 hover:text-blue-500 dark:text-neutral-600 dark:hover:text-blue-400 cursor-pointer transition-colors">
          Import .zma
          <input type="file" accept=".zma,.txt" onChange={handleZmaImport} className="hidden" />
        </label>
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Grid lines — horizontal (dB) */}
        {dbTicks.map(db => (
          <line
            key={db}
            x1={PADDING.left}
            y1={dbToY(db, dbMin)}
            x2={PADDING.left + PLOT_W}
            y2={dbToY(db, dbMin)}
            stroke={db === 0 ? refLineColor : gridColor}
            strokeWidth={db === 0 ? 1 : 0.5}
            strokeDasharray={db === 0 ? "4 2" : undefined}
          />
        ))}

        {/* Grid lines — vertical (frequency) */}
        {FREQ_TICKS.map(f => (
          <line
            key={f}
            x1={freqToX(f)}
            y1={PADDING.top}
            x2={freqToX(f)}
            y2={PADDING.top + PLOT_H}
            stroke={gridColor}
            strokeWidth={0.5}
          />
        ))}

        {/* dB axis labels */}
        {dbTicks.map(db => (
          <text
            key={db}
            x={PADDING.left - 4}
            y={dbToY(db, dbMin) + 3}
            textAnchor="end"
            fontSize={8}
            fill={textColor}
          >
            {db === 0 ? "0" : formatDb(db)}
          </text>
        ))}

        {/* Frequency axis labels */}
        {FREQ_TICKS.filter(f => FREQ_LABELS[f]).map(f => (
          <text
            key={f}
            x={freqToX(f)}
            y={PADDING.top + PLOT_H + 14}
            textAnchor="middle"
            fontSize={8}
            fill={textColor}
          >
            {FREQ_LABELS[f]}
          </text>
        ))}

        {/* "Hz" label */}
        <text
          x={PADDING.left + PLOT_W + 8}
          y={PADDING.top + PLOT_H + 14}
          fontSize={7}
          fill={textColor}
        >
          Hz
        </text>

        {/* "dB" label */}
        <text
          x={PADDING.left - 4}
          y={PADDING.top - 3}
          textAnchor="end"
          fontSize={7}
          fill={textColor}
        >
          dB
        </text>

        {/* Loss curves — fill first, then stroke on top */}
        {curvePaths.map(curve => (
          <path
            key={`fill-${curve.outputIndex}`}
            d={curve.fillPath}
            fill={curve.color.fill}
            stroke="none"
          />
        ))}
        {curvePaths.map(curve => (
          <path
            key={`line-${curve.outputIndex}`}
            d={curve.linePath}
            fill="none"
            stroke={curve.color.stroke}
            strokeWidth={1.5}
          />
        ))}

        {/* Legend labels at right edge */}
        {curvePaths.map((curve, i) => (
          <text
            key={`legend-${curve.outputIndex}`}
            x={PADDING.left + PLOT_W + 4}
            y={PADDING.top + 10 + i * 12}
            fontSize={8}
            fill={curve.color.stroke}
          >
            Out {curve.outputIndex + 1}
            {curve.hasOverride ? " ●" : ""}
          </text>
        ))}

        {/* Hover crosshair */}
        {hoverX !== null && hoverFreq !== null && hoverX >= PADDING.left && hoverX <= PADDING.left + PLOT_W && (
          <>
            <line
              x1={hoverX}
              y1={PADDING.top}
              x2={hoverX}
              y2={PADDING.top + PLOT_H}
              stroke={isDark ? "#666" : "#9ca3af"}
              strokeWidth={0.5}
              strokeDasharray="2 2"
            />
            {/* Frequency label at bottom */}
            <text
              x={hoverX}
              y={PADDING.top + PLOT_H + 24}
              textAnchor="middle"
              fontSize={8}
              fontWeight="bold"
              fill={textColor}
            >
              {hoverFreq >= 1000 ? `${(hoverFreq / 1000).toFixed(1)}k` : `${Math.round(hoverFreq)}`}
            </text>
            {/* dB values per curve */}
            {hoverValues?.map((db, i) => {
              if (db === null) return null;
              const y = dbToY(db, dbMin);
              const color = curvePaths[i]?.color.stroke ?? textColor;
              return (
                <g key={i}>
                  <circle cx={hoverX} cy={y} r={3} fill={color} />
                  <text
                    x={hoverX + 6}
                    y={y + 3}
                    fontSize={8}
                    fontWeight="bold"
                    fill={color}
                  >
                    {formatDb(db)} dB
                  </text>
                </g>
              );
            })}
          </>
        )}
      </svg>
    </div>
  );
}
