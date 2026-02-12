/**
 * Generic loudspeaker impedance model and .zma file parser.
 * Used to calculate frequency-dependent cable loss.
 */

import { ENCLOSURE_LOW_FREQUENCY } from "./frequencyData";
import { CABLE_RESISTANCE_PER_METER } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImpedancePoint {
  frequency: number;
  impedance: number;
}

export interface CableLossPoint {
  frequency: number;
  lossDb: number;
}

type EnclosureCategory = "subwoofer" | "two_way" | "three_way" | "point_source";

// ─── .zma Import Overrides (session-level) ───────────────────────────────────

const impedanceCurveOverrides: Record<string, ImpedancePoint[]> = {};

export function setImpedanceCurveOverride(enclosureName: string, curve: ImpedancePoint[]): void {
  impedanceCurveOverrides[enclosureName] = curve;
}

export function clearImpedanceCurveOverride(enclosureName: string): void {
  delete impedanceCurveOverrides[enclosureName];
}

export function hasImpedanceCurveOverride(enclosureName: string): boolean {
  return enclosureName in impedanceCurveOverrides;
}

// ─── .zma Parser ─────────────────────────────────────────────────────────────

/**
 * Parse an EASE .zma impedance file.
 * Format: lines with "frequency  magnitude  phase", comment lines start with *.
 */
export function parseZmaFile(contents: string): ImpedancePoint[] | null {
  const points: ImpedancePoint[] = [];

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/[\t\s,;]+/);
    if (parts.length < 2) continue;

    const frequency = parseFloat(parts[0]);
    const impedance = parseFloat(parts[1]);

    if (isNaN(frequency) || isNaN(impedance) || frequency <= 0 || impedance <= 0) continue;

    points.push({ frequency, impedance });
  }

  return points.length > 10 ? points : null;
}

// ─── Enclosure Categorization ────────────────────────────────────────────────

function categorizeEnclosure(signalChannels: string[]): EnclosureCategory {
  if (signalChannels.length === 1 && signalChannels[0] === "SB") return "subwoofer";
  if (signalChannels.length >= 3) return "three_way";
  if (signalChannels.length === 2 && signalChannels.includes("LF") && signalChannels.includes("HF")) return "two_way";
  return "point_source";
}

// ─── Generic Impedance Model ─────────────────────────────────────────────────

/** Generate log-spaced frequency points from 20Hz to 20kHz */
function logSpace(count: number): number[] {
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push(Math.pow(10, logMin + t * (logMax - logMin)));
  }
  return points;
}

/**
 * Generate a generic impedance curve based on enclosure type and specs.
 * This is an approximation — use .zma import for real data.
 */
export function generateImpedanceCurve(
  enclosureName: string,
  nominalImpedance: number,
  signalChannels: string[]
): ImpedancePoint[] {
  // Use override if available
  if (impedanceCurveOverrides[enclosureName]) {
    return impedanceCurveOverrides[enclosureName];
  }

  const category = categorizeEnclosure(signalChannels);
  const lowFreq = ENCLOSURE_LOW_FREQUENCY[enclosureName] ?? 60;
  const frequencies = logSpace(120);

  // Model parameters by category
  let Fs: number;        // Resonant frequency
  let Q: number;         // Resonance Q factor
  let peakRatio: number; // Peak impedance / nominal
  let crossoverFreq: number; // Crossover frequency for multi-way
  let crossoverQ: number;
  let crossoverPeakRatio: number;
  let inductanceCoeff: number; // HF rise coefficient

  switch (category) {
    case "subwoofer":
      Fs = lowFreq * 0.9;
      Q = 4;
      peakRatio = 3.5;
      crossoverFreq = 0;
      crossoverQ = 0;
      crossoverPeakRatio = 0;
      inductanceCoeff = 0.15;
      break;
    case "two_way":
      Fs = lowFreq * 1.1;
      Q = 3.5;
      peakRatio = 3.0;
      crossoverFreq = 1800;
      crossoverQ = 2.5;
      crossoverPeakRatio = 1.5;
      inductanceCoeff = 0.25;
      break;
    case "three_way":
      Fs = lowFreq * 1.1;
      Q = 3.5;
      peakRatio = 3.0;
      crossoverFreq = 1200;
      crossoverQ = 2.0;
      crossoverPeakRatio = 1.3;
      inductanceCoeff = 0.3;
      break;
    case "point_source":
    default:
      Fs = lowFreq * 1.2;
      Q = 3.0;
      peakRatio = 2.5;
      crossoverFreq = 0;
      crossoverQ = 0;
      crossoverPeakRatio = 0;
      inductanceCoeff = 0.2;
      break;
  }

  // DC resistance floor (~0.7 × nominal for typical speakers)
  const Zbase = nominalImpedance * 0.7;
  // Resonance peak amplitude above Zbase
  const peakAmplitude = nominalImpedance * peakRatio - Zbase;
  // Crossover peak amplitude
  const crossoverAmplitude = crossoverPeakRatio > 0 ? nominalImpedance * crossoverPeakRatio - Zbase : 0;

  return frequencies.map(f => {
    // Resonant peak (Lorentzian)
    const resonanceRatio = (f - Fs) / (Fs / Q);
    const Zresonance = peakAmplitude / (1 + resonanceRatio * resonanceRatio);

    // Crossover bump (if multi-way)
    let Zcrossover = 0;
    if (crossoverFreq > 0 && crossoverAmplitude > 0) {
      const xoverRatio = (f - crossoverFreq) / (crossoverFreq / crossoverQ);
      Zcrossover = crossoverAmplitude / (1 + xoverRatio * xoverRatio);
    }

    // Voice coil inductance rise (above ~2kHz)
    const Zinductance = inductanceCoeff * nominalImpedance * Math.sqrt(f / 2000);

    // Combine
    const Z = Math.max(Zbase, Zbase + Zresonance + Zcrossover + Zinductance);

    return { frequency: f, impedance: Z };
  });
}

// ─── Frequency-Dependent Cable Loss ──────────────────────────────────────────

/**
 * Calculate frequency-dependent cable loss from an impedance curve.
 * Returns loss in dB at each frequency point (negative values = attenuation).
 */
export function calculateFrequencyDependentLoss(
  impedanceCurve: ImpedancePoint[],
  cableLengthMeters: number,
  gaugeMm2: number
): CableLossPoint[] {
  const resistancePerMeter = CABLE_RESISTANCE_PER_METER[gaugeMm2];
  if (!resistancePerMeter || cableLengthMeters <= 0) return [];

  const Rcable = resistancePerMeter * cableLengthMeters * 2; // both conductors

  return impedanceCurve.map(({ frequency, impedance }) => ({
    frequency,
    lossDb: 20 * Math.log10(impedance / (impedance + Rcable)),
  }));
}
