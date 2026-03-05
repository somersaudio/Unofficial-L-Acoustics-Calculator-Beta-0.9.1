/**
 * Generic loudspeaker impedance model and .zma file parser.
 * Used to calculate frequency-dependent cable loss.
 */

import { ENCLOSURE_LOW_FREQUENCY } from "./frequencyData";
import { CABLE_RESISTANCE_PER_METER } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImpedancePoint {
  frequency: number;
  impedance: number;       // magnitude in ohms
  phaseDegrees?: number;   // phase angle in degrees (0 = purely resistive)
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
    const rawPhase = parts.length >= 3 ? parseFloat(parts[2]) : undefined;

    if (isNaN(frequency) || isNaN(impedance) || frequency <= 0 || impedance <= 0) continue;

    points.push({
      frequency,
      impedance,
      phaseDegrees: (rawPhase !== undefined && !isNaN(rawPhase)) ? rawPhase : undefined,
    });
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

  // DC resistance floor (~0.7 × nominal for typical speakers)
  const Zbase = nominalImpedance * 0.7;

  // ─── Ported Subwoofer: Double-hump impedance model ─────────────────────────
  // Bass-reflex enclosures have TWO resonance peaks (one below and one above the
  // port tuning frequency Fb) with a dip/saddle at Fb where impedance drops to Re.
  // This is fundamentally different from sealed/full-range speakers.
  if (category === "subwoofer") {
    // Port tuning frequency (Fb): slightly above -10dB point
    const Fb = lowFreq * 1.15;
    // Lower resonance peak (Fl): ~65-70% of Fb
    const Fl = Fb * 0.68;
    // Upper resonance peak (Fh): ~155-165% of Fb
    const Fh = Fb * 1.6;

    // Peak impedance for the two humps (3.5-4× nominal above Zbase)
    const peakAmplitude = nominalImpedance * 3.5 - Zbase;
    // Upper peak is typically slightly shorter than lower peak
    const upperPeakAmplitude = peakAmplitude * 0.85;

    // Q factors (narrowness of peaks)
    const Ql = 3.5;  // Lower peak Q
    const Qh = 4.5;  // Upper peak Q (typically sharper)

    // Subwoofers have minimal HF inductance rise (they don't operate above ~100-200 Hz)
    const inductanceCoeff = 0.08;

    return frequencies.map(f => {
      // Lower resonance peak (complex Lorentzian: Z = A / (1 + jx))
      // x = Q * (f/Fs - Fs/f) gives proper RLC phase response
      const lowerX = Ql * (f / Fl - Fl / f);
      const lowerDenom = 1 + lowerX * lowerX;
      const lowerReal = peakAmplitude / lowerDenom;
      const lowerImag = -peakAmplitude * lowerX / lowerDenom;

      // Upper resonance peak (complex Lorentzian)
      const upperX = Qh * (f / Fh - Fh / f);
      const upperDenom = 1 + upperX * upperX;
      const upperReal = upperPeakAmplitude / upperDenom;
      const upperImag = -upperPeakAmplitude * upperX / upperDenom;

      // Voice coil inductance (purely imaginary, positive = inductive)
      const Zinductance = inductanceCoeff * nominalImpedance * Math.sqrt(f / 2000);

      // Total complex impedance
      const realPart = Zbase + lowerReal + upperReal;
      const imagPart = lowerImag + upperImag + Zinductance;

      const impedance = Math.sqrt(realPart * realPart + imagPart * imagPart);
      const phaseDegrees = Math.atan2(imagPart, realPart) * (180 / Math.PI);

      return { frequency: f, impedance: Math.max(Zbase, impedance), phaseDegrees };
    });
  }

  // ─── Full-range / Multi-way speakers: Single-peak model ────────────────────
  let Fs: number;        // Resonant frequency
  let Q: number;         // Resonance Q factor
  let peakRatio: number; // Peak impedance / nominal
  let crossoverFreq: number; // Crossover frequency for multi-way
  let crossoverQ: number;
  let crossoverPeakRatio: number;
  let inductanceCoeff: number; // HF rise coefficient

  switch (category) {
    case "two_way":
      Fs = lowFreq * 1.2;
      Q = 3.5;
      peakRatio = 3.0;
      crossoverFreq = 1800;
      crossoverQ = 2.5;
      crossoverPeakRatio = 1.5;
      inductanceCoeff = 0.25;
      break;
    case "three_way":
      Fs = lowFreq * 1.2;
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

  // Resonance peak amplitude above Zbase
  const peakAmplitude = nominalImpedance * peakRatio - Zbase;
  // Crossover peak amplitude
  const crossoverAmplitude = crossoverPeakRatio > 0 ? nominalImpedance * crossoverPeakRatio - Zbase : 0;

  return frequencies.map(f => {
    // Resonant peak (complex Lorentzian: Z = A / (1 + jx))
    const resX = Q * (f / Fs - Fs / f);
    const resDenom = 1 + resX * resX;
    const resReal = peakAmplitude / resDenom;
    const resImag = -peakAmplitude * resX / resDenom;

    // Crossover bump (complex Lorentzian, if multi-way)
    let xoReal = 0, xoImag = 0;
    if (crossoverFreq > 0 && crossoverAmplitude > 0) {
      const xoX = crossoverQ * (f / crossoverFreq - crossoverFreq / f);
      const xoDenom = 1 + xoX * xoX;
      xoReal = crossoverAmplitude / xoDenom;
      xoImag = -crossoverAmplitude * xoX / xoDenom;
    }

    // Voice coil inductance (purely imaginary, positive = inductive)
    const Zinductance = inductanceCoeff * nominalImpedance * Math.sqrt(f / 2000);

    // Total complex impedance
    const realPart = Zbase + resReal + xoReal;
    const imagPart = resImag + xoImag + Zinductance;

    const impedance = Math.sqrt(realPart * realPart + imagPart * imagPart);
    const phaseDegrees = Math.atan2(imagPart, realPart) * (180 / Math.PI);

    return { frequency: f, impedance: Math.max(Zbase, impedance), phaseDegrees };
  });
}

// ─── Frequency-Dependent Cable Loss ──────────────────────────────────────────

// Physical constants
const COPPER_RESISTIVITY = 1.68e-8; // Ω·m at 20°C
const VACUUM_PERMEABILITY = 4 * Math.PI * 1e-7; // H/m (μ₀)
const COPPER_RELATIVE_PERMEABILITY = 1.0; // μᵣ for copper (non-magnetic)

// Linear self-inductance for twisted pair speaker cables by gauge.
// Based on L-Acoustics RS2015 measurements: ~0.4-0.8 μH/m.
// Thinner cables have closer conductors → higher inductance per meter.
const LINEAR_INDUCTANCE_BY_GAUGE: Record<number, number> = {
  1.5: 0.75e-6,  // H/m — AWG 16, thinner cable
  2.5: 0.65e-6,  // H/m — AWG 14
  4:   0.55e-6,  // H/m — AWG 11
  6:   0.45e-6,  // H/m — AWG 9, thicker cable
};
const DEFAULT_LINEAR_INDUCTANCE = 0.6e-6; // H/m fallback

/**
 * Calculate skin depth at a given frequency.
 * Skin depth is the distance below the conductor surface where current effectively flows.
 */
function calculateSkinDepth(frequency: number): number {
  // δ = sqrt(ρ / (π * μ * f))
  const mu = COPPER_RELATIVE_PERMEABILITY * VACUUM_PERMEABILITY;
  return Math.sqrt(COPPER_RESISTIVITY / (Math.PI * mu * frequency));
}

/**
 * Calculate frequency-dependent cable resistance including skin effect.
 * At low frequencies, entire conductor is used. At high frequencies, only outer "skin" conducts.
 */
function calculateCableResistance(
  frequency: number,
  cableLengthMeters: number,
  gaugeMm2: number,
  dcResistancePerMeter: number
): number {
  // Convert mm² to m²
  const areaM2 = gaugeMm2 * 1e-6;
  // Calculate conductor radius from area
  const radiusM = Math.sqrt(areaM2 / Math.PI);

  // Skin effect threshold frequency: when skin depth equals radius
  // f_threshold = ρ / (π * μ * r²)
  const mu = COPPER_RELATIVE_PERMEABILITY * VACUUM_PERMEABILITY;
  const fThreshold = COPPER_RESISTIVITY / (Math.PI * mu * radiusM * radiusM);

  let effectiveArea: number;

  if (frequency < fThreshold) {
    // Low frequency: entire conductor is used
    effectiveArea = areaM2;
  } else {
    // High frequency: skin effect dominates
    // Effective area ≈ 2πr·δ (hollow cylinder approximation)
    const skinDepth = calculateSkinDepth(frequency);
    effectiveArea = 2 * Math.PI * radiusM * skinDepth;
  }

  // R = ρ · l / A, factor of 2 for both conductors
  const resistance = (COPPER_RESISTIVITY * cableLengthMeters * 2) / effectiveArea;

  return resistance;
}

/**
 * Calculate inductive reactance of the cable.
 * XL = 2π · f · L₀ · length · 2 (factor of 2 for both conductors)
 * L₀ varies by cable gauge per RS2015 paper measurements.
 */
function calculateInductiveReactance(frequency: number, cableLengthMeters: number, gaugeMm2: number): number {
  const L0 = LINEAR_INDUCTANCE_BY_GAUGE[gaugeMm2] ?? DEFAULT_LINEAR_INDUCTANCE;
  return 2 * Math.PI * frequency * L0 * cableLengthMeters * 2;
}

/**
 * Calculate frequency-dependent cable loss from an impedance curve.
 * Implements RS2015 equation 6.3 (complex impedance voltage divider):
 *   G_dB = 20·log( R / sqrt( (R·cosθ + Rcable)² + (R·sinθ + XL)² ) )
 * Includes:
 * - Frequency-dependent resistance (skin effect, eq. 2.2)
 * - Inductive reactance (gauge-dependent, eq. 3)
 * - Speaker impedance phase (eq. 5: Z_load = R·e^jθ)
 * Returns loss in dB at each frequency point (negative = attenuation, positive = boost).
 */
export function calculateFrequencyDependentLoss(
  impedanceCurve: ImpedancePoint[],
  cableLengthMeters: number,
  gaugeMm2: number
): CableLossPoint[] {
  const dcResistancePerMeter = CABLE_RESISTANCE_PER_METER[gaugeMm2];
  if (!dcResistancePerMeter || cableLengthMeters <= 0) return [];

  return impedanceCurve.map(({ frequency, impedance, phaseDegrees }) => {
    // Cable resistance including skin effect (eq. 2.2)
    const Rcable = calculateCableResistance(frequency, cableLengthMeters, gaugeMm2, dcResistancePerMeter);

    // Inductive reactance, gauge-dependent (eq. 3)
    const XL = calculateInductiveReactance(frequency, cableLengthMeters, gaugeMm2);

    // Speaker impedance as complex number (eq. 5: Z_load = R·e^jθ)
    const R = impedance;
    const theta = ((phaseDegrees ?? 0) * Math.PI) / 180;

    // Complex voltage divider per RS2015 eq. 6.3 (Z_out ≈ 0):
    // G = R / |R·e^jθ + Zcable| = R / sqrt((R·cosθ + Rcable)² + (R·sinθ + XL)²)
    const realPart = R * Math.cos(theta) + Rcable;
    const imagPart = R * Math.sin(theta) + XL;
    const denominator = Math.sqrt(realPart * realPart + imagPart * imagPart);

    const lossDb = denominator > 0 ? 20 * Math.log10(R / denominator) : -60;

    return { frequency, lossDb };
  });
}
