// =============================================================================
// Pull-sheet model — shared derivation logic for the equipment/pull-sheet PDF.
//
// Every rule here is ported verbatim from the on-screen components so the PDF
// provably matches what the user sees:
//   - channels-per-unit / physical-unit counting  ← ampSolver.ts getChannelsPerUnit
//   - per-array rigging resolution + stack weight  ← EnclosureSelector.tsx (~472-637)
//   - amp-side connector / breakout / jumper chain ← SolverResults.tsx CableChain (~109-230)
//
// Facts only: weights, codes, and capacities come straight from rigging_parts.json.
// Where the data cannot support a quantity (accessory counts, amp weights, run
// lengths) the model says so rather than fabricating a number.
// =============================================================================

import type {
  ZoneWithSolution,
  EnclosureRequest,
  RiggingPartsData,
  RiggingPart,
  Enclosure,
  AmpInstance,
} from "../types";
import { getMaxCableLength, CABLE_GAUGES } from "../types";

export const LBS_PER_KG = 2.20462;
/** Ground-stacked "on the floor", no rigging hardware. Mirrors EnclosureSelector.tsx:8. */
export const NO_RIGGING = "N/A";

/** Ported from ampSolver.ts:335 — amp channels consumed per physical enclosure. */
export function getChannelsPerUnit(enc: Enclosure, ampConfigKey?: string): number {
  if (ampConfigKey && enc.signal_channels_override?.[ampConfigKey] !== undefined) {
    return enc.signal_channels_override[ampConfigKey];
  }
  return enc.signal_channels.length;
}

/** Convert an amp's channel-summed enclosure count into physical boxes. */
export function physicalUnits(summedChannelCount: number, channelsPerUnit: number): number {
  return channelsPerUnit > 1
    ? Math.max(1, Math.round(summedChannelCount / channelsPerUnit))
    : summedChannelCount;
}

const deployWordFor = (mode?: string): string =>
  mode === "ground_stack" ? "stacked" : mode === "surface_mount" ? "mounted" : "flown";

export interface ResolvedArrayRigging {
  encName: string;
  quantity: number; // physical boxes (request.quantity)
  hasData: boolean; // false when no rigging_parts entry exists for this enclosure
  noRigging: boolean; // true for the "N/A" ground-stacked-no-hardware case
  deploymentMode?: string;
  deploymentLabel: string; // human label, e.g. "Flown (truss / motor)"
  deployWord: string; // flown | stacked | mounted
  frame?: RiggingPart; // the resolved primary flying frame / bumper (1 per array)
  safe: number | null; // recommended max boxes in this array for this deployment
  max: number | null; // absolute max boxes (hard cap)
  encWeightKg: number | null;
  frameWeightKg: number | null; // null when the frame has no published weight
  arrayWeightKg: number | null; // encW*qty + frameKg; null if enclosure weight unknown
  arrayWeightIsLowerBound: boolean; // true when a contributing weight was null
  optionalParts: RiggingPart[]; // situational parts for this deployment (never auto-included)
  manualUrl?: string;
}

/**
 * Resolve the rigging for one array (request), using the EXACT screen precedence:
 * deployment default → recommended fallback → first part; a valid user override wins.
 * (EnclosureSelector.tsx:472-494, weight at :622-637.)
 */
export function resolveArrayRigging(
  req: EnclosureRequest,
  rigging?: RiggingPartsData
): ResolvedArrayRigging {
  const encName = req.enclosure.enclosure;
  const row = rigging?.enclosures?.[encName];
  const parts = row?.rigging_parts ?? [];

  const rowDeployMode =
    req.deploymentMode && row?.deployments?.some((d) => d.mode === req.deploymentMode)
      ? req.deploymentMode
      : row?.deployments?.[0]?.mode;
  const rowDeploy = row?.deployments?.find((d) => d.mode === rowDeployMode);
  const rowRiggingCode = rowDeploy?.default_rigging ?? row?.recommended_rigging;

  const exists = (c?: string) => !!c && parts.some((p) => p.code === c);
  const valid = (c?: string) => c === NO_RIGGING || exists(c);
  const selectedCode = valid(req.riggingCode)
    ? req.riggingCode
    : exists(rowRiggingCode)
      ? rowRiggingCode
      : parts[0]?.code;

  const noRigging = selectedCode === NO_RIGGING;
  const frame = noRigging ? undefined : parts.find((p) => p.code === selectedCode);

  const encWeightKg = typeof row?.weight_kg === "number" ? row.weight_kg : null;
  const frameWeightKg = frame ? (typeof frame.weight_kg === "number" ? frame.weight_kg : null) : null;

  let arrayWeightKg: number | null = null;
  let lowerBound = false;
  if (encWeightKg !== null) {
    arrayWeightKg = encWeightKg * req.quantity + (frameWeightKg ?? 0);
    if (frame && frameWeightKg === null) lowerBound = true; // frame weight unknown
  }

  // Optional/situational parts: everything except the chosen frame, filtered to the
  // deployment (pole/yoke mounts only make sense for surface mounting).
  const optionalParts = parts.filter((p) => {
    if (p.code === selectedCode) return false;
    if (rowDeployMode !== "surface_mount" && (p.category === "pole_mount" || p.category === "bracket_yoke")) {
      return false;
    }
    return true;
  });

  return {
    encName,
    quantity: req.quantity,
    hasData: !!row,
    noRigging,
    deploymentMode: rowDeployMode,
    deploymentLabel: rowDeploy?.label ?? deployWordFor(rowDeployMode),
    deployWord: deployWordFor(rowDeployMode),
    frame,
    safe: noRigging ? null : (rowDeploy?.safe ?? null),
    max: noRigging ? null : (rowDeploy?.max ?? null),
    encWeightKg,
    frameWeightKg,
    arrayWeightKg,
    arrayWeightIsLowerBound: lowerBound,
    optionalParts,
    manualUrl: row?.rigging_pdf,
  };
}

export interface CableRun {
  connector: string; // per-channel connector after any break-out (NL4 / NL2 / PA-COM)
  physBoxes: number; // physical boxes daisy-chained on this one channel run
  jumpers: number; // physBoxes - 1 (0 for a single box or a Y-split fan)
  isYSplit: boolean; // non-parallel enclosure: one Y-cable fans to all boxes (no daisy-chain)
  impedanceOhms: number; // the solver's load impedance for this output (authoritative)
  enclosures: string[]; // enclosure model names on this run
}

export interface AmpCabling {
  ampId: string;
  ampLabel: string; // model (+ mode)
  ampTail: string; // amp-side feed: "NL8" (LA12X loom), "PA-COM", or "" when per-channel tails
  breakout?: string; // "(2) NL4" | "(4) NL2" — the NL8 break-out for LA12X
  isLA12X: boolean;
  runs: CableRun[]; // one per primary (non-secondary) loaded channel; each carries its own connector
  primaryLoadedCount: number;
  minImpedanceOhms: number | null; // worst-case (lowest) load across this amp's runs
  gaugeMm2: number;
  gaugeAwg: number;
  maxLenMeters: number | null;
  maxLenFeet: number | null;
  maxLenEstimated: boolean;
}

/**
 * Per-amplifier cabling, derived from the solver's actual output allocation — mirrors the
 * on-screen CombinedNL8Chain (SolverResults.tsx:350-580): for LA12X, one NL8 amp tail breaking
 * out to (2) NL4 (<=2 primary channels) or (4) NL2 (3+); PA-COM for >=4-channel enclosures; else
 * NL4/NL2 PER CHANNEL based on that channel's own enclosure (so a mixed amp shows both). Jumpers
 * and load impedance are computed PER OUTPUT — never the whole array lumped onto one chain — and
 * impedance is read straight from output.impedanceOhms so it matches the screen.
 */
export function computeAmpCabling(instance: AmpInstance, gaugeMm2: number, racked: boolean): AmpCabling | null {
  const ampKey = instance.ampConfig.key;
  const loaded = instance.outputs.filter((o) => o.totalEnclosures > 0);
  if (loaded.length === 0) return null;
  const primaryEnc = loaded[0].enclosures[0]?.enclosure;
  if (!primaryEnc) return null;

  // Secondary (e.g. HF/MF) channels of multi-channel enclosures: the cable feeds the primary
  // channel of the pair, so these are not separate cable runs.
  const allocated = new Set<number>();
  for (const o of instance.outputs) {
    for (const e of o.enclosures) {
      if (e.count > 0) {
        const cpu = getChannelsPerUnit(e.enclosure, ampKey);
        if (cpu > 1 && o.outputIndex % cpu !== 0) allocated.add(o.outputIndex);
      }
    }
  }
  const primaryOutputs = instance.outputs.filter(
    (o) => o.totalEnclosures > 0 && !allocated.has(o.outputIndex)
  );
  const primaryLoadedCount = primaryOutputs.length;

  const isPACOM = getChannelsPerUnit(primaryEnc, ampKey) >= 4; // PA-COM enclosures (K1/K2…) defer from NL8
  // Only treat an LA12X as a single NL8 service-amp loom when it's actually in an LA-RAK. A SOLO
  // LA12X is cabled per channel (NL4/NL2) like any loose amp — matching the on-screen views.
  const isLA12X = ampKey === "LA12X" && !isPACOM && racked;
  const la12xBreakoutConn = primaryLoadedCount >= 3 ? "NL2" : "NL4";
  const ampTail = isPACOM ? "PA-COM" : isLA12X ? "NL8" : "";
  const breakout = isLA12X ? (primaryLoadedCount >= 3 ? "(4) NL2" : "(2) NL4") : undefined;

  const runs: CableRun[] = primaryOutputs.map((o) => {
    let physBoxes = 0;
    let isYSplit = false;
    const names: string[] = [];
    const runEnc = o.enclosures.find((e) => e.count > 0)?.enclosure;
    for (const e of o.enclosures) {
      if (e.count <= 0) continue;
      const cpu = getChannelsPerUnit(e.enclosure, ampKey);
      const pc = cpu > 1 ? Math.max(1, Math.round(e.count / cpu)) : e.count;
      physBoxes += pc;
      if (e.enclosure.parallelAllowed === false && pc > 1) isYSplit = true;
      if (!names.includes(e.enclosure.enclosure)) names.push(e.enclosure.enclosure);
    }
    // Per-run connector: LA12X uses its uniform break-out leg; otherwise it follows THIS channel's
    // own enclosure (single-channel → NL2, multi-channel → NL4, 4+ channel → PA-COM).
    const runCpu = runEnc ? getChannelsPerUnit(runEnc, ampKey) : 1;
    const connector = isLA12X
      ? la12xBreakoutConn
      : runCpu >= 4
        ? "PA-COM"
        : runCpu === 1 && runEnc?.signal_channels.length === 1
          ? "NL2"
          : "NL4";
    return {
      connector,
      physBoxes,
      jumpers: isYSplit ? 0 : Math.max(0, physBoxes - 1),
      isYSplit,
      impedanceOhms: o.impedanceOhms,
      enclosures: names,
    };
  });

  const finiteImps = runs.map((r) => r.impedanceOhms).filter((z) => Number.isFinite(z) && z > 0);
  const minImpedanceOhms = finiteImps.length ? Math.min(...finiteImps) : null;
  const gauge = CABLE_GAUGES.find((g) => g.mm2 === gaugeMm2);
  const maxLen = minImpedanceOhms !== null ? getMaxCableLength(minImpedanceOhms, gaugeMm2) : null;

  return {
    ampId: instance.id,
    ampLabel: instance.ampConfig.model + (instance.ampConfig.mode ? ` (${instance.ampConfig.mode})` : ""),
    ampTail,
    breakout,
    isLA12X,
    runs,
    primaryLoadedCount,
    minImpedanceOhms: minImpedanceOhms !== null ? Math.round(minImpedanceOhms * 100) / 100 : null,
    gaugeMm2,
    gaugeAwg: gauge?.awg ?? 0,
    maxLenMeters: maxLen?.meters ?? null,
    maxLenFeet: maxLen?.feet ?? null,
    maxLenEstimated: !!maxLen?.estimated,
  };
}

/** Aggregate an amp's cable runs into per-connector tail / jumper / Y-split counts. */
export function tallyAmpCables(ac: AmpCabling): { tails: Map<string, number>; jumpers: Map<string, number>; ysplits: Map<string, number> } {
  const tails = new Map<string, number>();
  const jumpers = new Map<string, number>();
  const ysplits = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, n: number) => { if (n > 0) m.set(k, (m.get(k) ?? 0) + n); };
  for (const r of ac.runs) {
    if (!ac.isLA12X) bump(tails, r.connector, 1); // LA12X tail is the single NL8 loom, counted separately
    bump(jumpers, r.connector, r.jumpers);
    bump(ysplits, r.connector, r.isYSplit ? 1 : 0);
  }
  return { tails, jumpers, ysplits };
}

export interface PullArray {
  encName: string;
  quantity: number; // physical boxes
  rigging: ResolvedArrayRigging;
  ampConfigKey?: string;
}

export interface PullZone {
  name: string;
  arrays: PullArray[];
  amps: AmpInstance[];
  cabling: AmpCabling[]; // one entry per amp instance (cabling is per-amp, not per-array)
  loudspeakerKg: number; // physical boxes only
  riggingKg: number; // resolved frames only
  zoneWeightKg: number; // loudspeakers + rigging (excl. amps)
  weightIsLowerBound: boolean;
}

export interface BomLine {
  code: string;
  description: string;
  category: string; // amplifier | loudspeaker | <rigging category> | cabling
  qty: number;
  unitKg: number | null; // null = weight not in data
  lineKg: number | null;
}

export interface PullSheetModel {
  zones: PullZone[];
  bom: BomLine[]; // consolidated shop pull total, already ordered for the warehouse
  totals: {
    zones: number;
    arrays: number;
    amps: number;
    laRaks: number;
    loudspeakerKg: number;
    riggingKg: number;
    systemKg: number; // excl. amps
    weightIsLowerBound: boolean;
    enclosureCounts: Map<string, number>; // physical boxes by model
  };
  manuals: Map<string, string>; // enclosure name -> rigging_pdf
  assumptions: string[]; // the explicit "confirm / not in data" callouts
}

const RACK_SIZE = 3;

/** Category sort order for the consolidated BOM — biggest steel first. */
const CATEGORY_ORDER: Record<string, number> = {
  amplifier: 0,
  loudspeaker: 1,
  flying_frame: 2,
  rigging_bar: 3,
  downfill: 4,
  link_plate: 5,
  coupling_bar: 6,
  bracket_yoke: 7,
  pole_mount: 8,
  truss_clamp: 9,
  accessory: 10,
  cabling: 11,
};

/** Build the complete pull-sheet model from the solved zones. */
export function buildPullSheetModel(
  zoneSolutions: ZoneWithSolution[],
  rigging: RiggingPartsData | undefined,
  gaugeMm2: number,
  rackMode: boolean
): PullSheetModel {
  const zones: PullZone[] = [];

  // BOM accumulators keyed by a stable identity.
  const ampBom = new Map<string, BomLine>();
  const speakerBom = new Map<string, BomLine>();
  const riggingBom = new Map<string, BomLine>();
  const cableBom = new Map<string, BomLine>();

  const manuals = new Map<string, string>();
  const enclosureCounts = new Map<string, number>();
  let totalArrays = 0;
  let totalAmps = 0;
  let totalLaRaks = 0;
  const laRakIds = new Set<string>();
  let assumeAccessoryQty = false;
  let assumeFramePerArray = false;
  let anyAmp = false;
  let globalLowerBound = false;

  const addCable = (connector: string, role: string, n: number) => {
    if (n <= 0) return;
    const key = `${connector}|${role}`;
    const ex = cableBom.get(key);
    if (ex) ex.qty += n;
    else cableBom.set(key, { code: connector, description: role, category: "cabling", qty: n, unitKg: null, lineKg: null });
  };

  for (const zs of zoneSolutions) {
    const solution = zs.solution;
    if (!solution || !solution.success) continue;
    const amps = solution.ampInstances;

    // Map each enclosure type -> an amp config powering it (for connector choice).
    const ampKeyForEnc = new Map<string, string>();
    for (const amp of amps) {
      for (const out of amp.outputs) {
        for (const e of out.enclosures) {
          if (!ampKeyForEnc.has(e.enclosure.enclosure)) {
            ampKeyForEnc.set(e.enclosure.enclosure, amp.ampConfig.key);
          }
        }
      }
    }

    const arrays: PullArray[] = [];
    let zoneSpeakerKg = 0;
    let zoneRiggingKg = 0;
    let zoneLowerBound = false;

    for (const req of zs.zone.requests) {
      const encName = req.enclosure.enclosure;
      const rig = resolveArrayRigging(req, rigging);
      const ampKey = ampKeyForEnc.get(encName);

      arrays.push({ encName, quantity: req.quantity, rigging: rig, ampConfigKey: ampKey });
      totalArrays++;
      enclosureCounts.set(encName, (enclosureCounts.get(encName) ?? 0) + req.quantity);

      // Weights
      if (rig.encWeightKg !== null) zoneSpeakerKg += rig.encWeightKg * req.quantity;
      else zoneLowerBound = true;
      if (rig.frame) {
        if (rig.frameWeightKg !== null) zoneRiggingKg += rig.frameWeightKg;
        else zoneLowerBound = true;
      }

      // BOM — loudspeakers (physical)
      {
        const ex = speakerBom.get(encName);
        if (ex) {
          ex.qty += req.quantity;
          ex.lineKg = ex.unitKg !== null ? ex.unitKg * ex.qty : null;
        } else {
          speakerBom.set(encName, {
            code: encName,
            description: `${encName} enclosure`,
            category: "loudspeaker",
            qty: req.quantity,
            unitKg: rig.encWeightKg,
            lineKg: rig.encWeightKg !== null ? rig.encWeightKg * req.quantity : null,
          });
        }
      }

      // BOM — rigging frame (1 per array, the only safely-derivable rigging qty)
      if (rig.frame) {
        assumeFramePerArray = true;
        const ex = riggingBom.get(rig.frame.code);
        if (ex) {
          ex.qty += 1;
          ex.lineKg = ex.unitKg !== null ? ex.unitKg * ex.qty : null;
        } else {
          riggingBom.set(rig.frame.code, {
            code: rig.frame.code,
            description: rig.frame.name,
            category: rig.frame.category || "flying_frame",
            qty: 1,
            unitKg: rig.frameWeightKg,
            lineKg: rig.frameWeightKg,
          });
        }
      }
      if (rig.optionalParts.length > 0) assumeAccessoryQty = true;

      if (rig.manualUrl) manuals.set(encName, rig.manualUrl);
    }

    // BOM — amplifiers + LA-RAK tally
    for (const amp of amps) {
      anyAmp = true;
      totalAmps++;
      const model = amp.ampConfig.model + (amp.ampConfig.mode ? ` (${amp.ampConfig.mode})` : "");
      const ex = ampBom.get(model);
      if (ex) ex.qty += 1;
      else ampBom.set(model, { code: amp.ampConfig.model, description: `${model} amplified controller`, category: "amplifier", qty: 1, unitKg: null, lineKg: null });
      if (amp.ampConfig.key === "LA12X") laRakIds.add(amp.rackGroupId ?? `__loose-${amp.id}`);
    }

    // Cabling — PER AMP (from the solver's real outputs), then rolled into the BOM. An LA12X amp
    // is one NL8 break-out loom; other amps are one channel-connector tail per primary channel.
    // Jumpers are summed per channel run, not lumped across the whole array.
    const cabling: AmpCabling[] = [];
    for (const amp of amps) {
      const ac = computeAmpCabling(amp, gaugeMm2, rackMode);
      if (!ac) continue;
      cabling.push(ac);
      if (ac.isLA12X) addCable("NL8", `amp loom -> ${ac.breakout ?? "NL4"}`, 1);
      const { tails, jumpers, ysplits } = tallyAmpCables(ac);
      for (const [conn, n] of tails) addCable(conn, "amp tail", n);
      for (const [conn, n] of jumpers) addCable(conn, "inter-cabinet jumper", n);
      for (const [conn, n] of ysplits) addCable(conn, "Y-split", n);
    }

    zones.push({
      name: zs.zone.name,
      arrays,
      amps,
      cabling,
      loudspeakerKg: Math.round(zoneSpeakerKg),
      riggingKg: Math.round(zoneRiggingKg),
      zoneWeightKg: Math.round(zoneSpeakerKg + zoneRiggingKg),
      weightIsLowerBound: zoneLowerBound,
    });
    if (zoneLowerBound) globalLowerBound = true;
  }

  // LA-RAK count: explicit rack groups + loose LA12X chunked into racks of 3.
  {
    const explicit = [...laRakIds].filter((k) => !k.startsWith("__loose-")).length;
    const loose = [...laRakIds].filter((k) => k.startsWith("__loose-")).length;
    totalLaRaks = explicit + Math.ceil(loose / RACK_SIZE);
  }

  // Assemble + order the consolidated BOM.
  const bom: BomLine[] = [
    ...ampBom.values(),
    ...speakerBom.values(),
    ...riggingBom.values(),
    ...cableBom.values(),
  ].sort((a, b) => {
    const ca = CATEGORY_ORDER[a.category] ?? 99;
    const cb = CATEGORY_ORDER[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    return b.qty - a.qty;
  });

  const loudspeakerKg = zones.reduce((s, z) => s + z.loudspeakerKg, 0);
  const riggingKg = zones.reduce((s, z) => s + z.riggingKg, 0);

  const assumptions: string[] = [];
  if (assumeFramePerArray) assumptions.push("Flying frames counted 1 per array (per-array quantity is not in the data).");
  if (assumeAccessoryQty) assumptions.push("Accessory quantities (pins, shackles, pull-backs, extension bars, clamps) are per the rigging manual — not derivable from the data.");
  assumptions.push("Cabling is per amp output: jumpers = boxes on a channel - 1; load impedance is the solver's per-output value.");
  if (anyAmp) assumptions.push("Amplifier weights, mains current/draw, and motor/point selection are not in the app data — confirm separately.");

  return {
    zones,
    bom,
    totals: {
      zones: zones.length,
      arrays: totalArrays,
      amps: totalAmps,
      laRaks: totalLaRaks,
      loudspeakerKg,
      riggingKg,
      systemKg: loudspeakerKg + riggingKg,
      weightIsLowerBound: globalLowerBound,
      enclosureCounts,
    },
    manuals,
    assumptions,
  };
}

/** Format a kg value in the user's preferred unit; null -> "n/a". */
export function fmtWeight(kg: number | null, lbs: boolean): string {
  if (kg === null) return "n/a";
  return lbs ? `${Math.round(kg * LBS_PER_KG)} lb` : `${Math.round(kg)} kg`;
}
