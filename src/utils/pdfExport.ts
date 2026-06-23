import { jsPDF } from "jspdf";
import type { ZoneWithSolution, RiggingPartsData, AmpInstance } from "../types";
import {
  buildPullSheetModel,
  getChannelsPerUnit,
  physicalUnits,
  fmtWeight,
  tallyAmpCables,
  type PullArray,
} from "./pullSheet";
import lacousticsLogo from "../assets/lacoustics-logo.png";

const PAGE_WIDTH = 210; // A4 (mm)
const PAGE_BOTTOM = 282;
const MARGIN = 14;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 182

interface PDFExportOptions {
  zoneSolutions: ZoneWithSolution[];
  rackMode?: boolean;
  riggingParts?: RiggingPartsData;
  cableGaugeMm2?: number;
  useFeet?: boolean;
  weightInLbs?: boolean;
}

interface TableColumn {
  header: string;
  width: number;
  align?: "left" | "right" | "center";
  checkbox?: boolean;
}

interface TableRow {
  cells: string[];
  bold?: boolean;
  checkbox?: boolean; // draw a tick box in the checkbox column (default true)
}

// Load image and convert to base64, returning dimensions for correct aspect ratio
async function loadImageWithDimensions(src: string): Promise<{ base64: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve({ base64: canvas.toDataURL("image/png"), width: img.width, height: img.height });
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/** Sum physical enclosure boxes (not amp channels) across a set of amps, by model. */
function physicalEnclosureTotals(amps: AmpInstance[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const amp of amps) {
    const perEnc = new Map<string, number>();
    for (const out of amp.outputs) {
      for (const e of out.enclosures) {
        perEnc.set(e.enclosure.enclosure, (perEnc.get(e.enclosure.enclosure) ?? 0) + e.count);
      }
    }
    for (const [name, summed] of perEnc) {
      const enc = amp.outputs.flatMap((o) => o.enclosures).find((e) => e.enclosure.enclosure === name)!.enclosure;
      const phys = physicalUnits(summed, getChannelsPerUnit(enc, amp.ampConfig.key));
      totals.set(name, (totals.get(name) ?? 0) + phys);
    }
  }
  return totals;
}

export async function generatePDFReport(options: PDFExportOptions): Promise<void> {
  const {
    zoneSolutions,
    rackMode = false,
    riggingParts,
    cableGaugeMm2 = 4,
    useFeet = true,
    weightInLbs = false,
  } = options;

  const model = buildPullSheetModel(zoneSolutions, riggingParts, cableGaugeMm2, rackMode);
  const isMultiZone = model.zones.length > 1;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let yPos = MARGIN;

  // ---- small drawing helpers -------------------------------------------------
  const ensure = (needed: number) => {
    if (yPos + needed > PAGE_BOTTOM) {
      doc.addPage();
      yPos = MARGIN;
    }
  };
  const fit = (text: string, maxW: number): string => {
    if (doc.getTextWidth(text) <= maxW) return text;
    let s = text;
    while (s.length > 1 && doc.getTextWidth(s + "…") > maxW) s = s.slice(0, -1);
    return s + "…";
  };
  const heading = (text: string, size = 13) => {
    ensure(12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(0);
    doc.text(text, MARGIN, yPos);
    yPos += 1.5;
    doc.setDrawColor(150);
    doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
    yPos += 6;
  };
  const para = (text: string, opts: { size?: number; gray?: number; indent?: number; gap?: number } = {}) => {
    const { size = 9, gray = 0, indent = 0, gap = 4.6 } = opts;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(gray);
    const lines = doc.splitTextToSize(text, CONTENT_WIDTH - indent) as string[];
    for (const line of lines) {
      ensure(gap + 1);
      doc.text(line, MARGIN + indent, yPos);
      yPos += gap;
    }
    doc.setTextColor(0);
  };

  // Reusable table renderer: header repeat on page break, zebra rows, tick-box column.
  const drawTable = (cols: TableColumn[], rows: TableRow[]) => {
    const totalW = cols.reduce((s, c) => s + c.width, 0);
    const drawHeader = () => {
      doc.setFillColor(55, 55, 55);
      doc.rect(MARGIN, yPos, totalW, 6, "F");
      doc.setTextColor(255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      let x = MARGIN;
      for (const c of cols) {
        const tx = c.align === "right" ? x + c.width - 2 : c.align === "center" ? x + c.width / 2 : x + 2;
        doc.text(c.header, tx, yPos + 4, { align: c.align === "right" ? "right" : c.align === "center" ? "center" : "left" });
        x += c.width;
      }
      yPos += 6;
      doc.setTextColor(0);
      doc.setFont("helvetica", "normal");
    };
    ensure(14);
    drawHeader();
    rows.forEach((row, i) => {
      if (yPos + 5.5 > PAGE_BOTTOM) {
        doc.addPage();
        yPos = MARGIN;
        drawHeader();
      }
      if (i % 2 === 1) {
        doc.setFillColor(243, 243, 243);
        doc.rect(MARGIN, yPos, totalW, 5.5, "F");
      }
      let x = MARGIN;
      doc.setFontSize(8);
      cols.forEach((c, ci) => {
        if (c.checkbox) {
          if (row.checkbox !== false) {
            doc.setDrawColor(120);
            doc.rect(x + c.width / 2 - 1.8, yPos + 1, 3.6, 3.6, "S");
          }
        } else {
          doc.setFont("helvetica", row.bold ? "bold" : "normal");
          const val = row.cells[ci] ?? "";
          const tx = c.align === "right" ? x + c.width - 2 : c.align === "center" ? x + c.width / 2 : x + 2;
          doc.text(fit(val, c.width - 3), tx, yPos + 4, {
            align: c.align === "right" ? "right" : c.align === "center" ? "center" : "left",
          });
        }
        x += c.width;
      });
      yPos += 5.5;
    });
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0);
  };

  // ---- header / logo / job metadata -----------------------------------------
  try {
    const logo = await loadImageWithDimensions(lacousticsLogo);
    const logoHeight = 8;
    doc.addImage(logo.base64, "PNG", MARGIN, yPos - 2, logoHeight * (logo.width / logo.height), logoHeight);
  } catch {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("L-Acoustics", MARGIN, yPos + 4);
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text("Equipment Pull Sheet", PAGE_WIDTH - MARGIN, yPos + 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleDateString()}`, PAGE_WIDTH - MARGIN, yPos + 6, { align: "right" });
  doc.setTextColor(0);
  yPos += 14;

  // Job metadata — fill-in lines (no job-metadata field exists in the app yet).
  const labelLine = (label: string, x: number, w: number) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(label, x, yPos);
    const lx = x + doc.getTextWidth(label) + 2;
    doc.setDrawColor(180);
    doc.line(lx, yPos + 0.5, x + w, yPos + 0.5);
    doc.setTextColor(0);
  };
  const half = CONTENT_WIDTH / 2;
  labelLine("Job / Event:", MARGIN, half - 4);
  labelLine("Client:", MARGIN + half, half);
  yPos += 6.5;
  labelLine("Venue:", MARGIN, half - 4);
  labelLine("Show date(s):", MARGIN + half, half);
  yPos += 6.5;
  labelLine("Prepared by:", MARGIN, half - 4);
  labelLine("Rev / Quote #:", MARGIN + half, half);
  yPos += 10;

  // ---- roll-up summary -------------------------------------------------------
  const t = model.totals;
  doc.setFillColor(235, 235, 235);
  doc.rect(MARGIN, yPos - 4, CONTENT_WIDTH, 13, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(
    `${t.zones} zone${t.zones !== 1 ? "s" : ""}  ·  ${t.arrays} array${t.arrays !== 1 ? "s" : ""}  ·  ${t.amps} amplifier${t.amps !== 1 ? "s" : ""}  ·  ${t.laRaks} LA-RAK`,
    MARGIN + 3,
    yPos + 1
  );
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const sysWt = `${fmtWeight(t.systemKg, weightInLbs)}${t.weightIsLowerBound ? "+" : ""}`;
  doc.text(
    `System weight (loudspeakers ${fmtWeight(t.loudspeakerKg, weightInLbs)} + rigging ${fmtWeight(t.riggingKg, weightInLbs)}) = ${sysWt}  ·  excl. amplifiers (weight not in data)`,
    MARGIN + 3,
    yPos + 6
  );
  yPos += 16;

  // ---- consolidated shop pull total (BOM) — pull against this ----------------
  heading("Shop Pull Total");
  para("Consolidated bill of materials for the whole job — pull against this list. Detail by zone follows.", { size: 8, gray: 110, gap: 4.2 });
  yPos += 1;
  const wcol = weightInLbs ? "lb" : "kg";
  drawTable(
    [
      { header: "Qty", width: 12, align: "right" },
      { header: "Code", width: 30 },
      { header: "Description", width: 64 },
      { header: "Category", width: 28 },
      { header: `Unit ${wcol}`, width: 16, align: "right" },
      { header: `Line ${wcol}`, width: 18, align: "right" },
      { header: "Pulled", width: 14, align: "center", checkbox: true },
    ],
    model.bom.map((b) => ({
      cells: [
        String(b.qty),
        b.code,
        b.description,
        b.category.replace(/_/g, " "),
        b.unitKg === null ? "—" : fmtWeight(b.unitKg, weightInLbs).replace(/ (kg|lb)$/, ""),
        b.lineKg === null ? "—" : fmtWeight(b.lineKg, weightInLbs).replace(/ (kg|lb)$/, ""),
        "",
      ],
    }))
  );
  yPos += 6;

  // ---- per-array renderer ----------------------------------------------------
  const renderArray = (arr: PullArray, n: number) => {
    const r = arr.rigging;
    ensure(10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    const cap = r.max != null ? `  ·  ${arr.quantity} of MAX ${r.max}${r.safe != null && arr.quantity > r.safe ? " — over safe" : ""}` : "";
    doc.text(`Array ${n} — ${arr.quantity}× ${arr.encName}  (${r.deployWord})${cap}`, MARGIN, yPos);
    yPos += 4.8;

    para(
      `Loudspeakers: ${arr.quantity}× ${arr.encName} @ ${fmtWeight(r.encWeightKg, weightInLbs)} = ${fmtWeight(r.encWeightKg !== null ? r.encWeightKg * arr.quantity : null, weightInLbs)}`,
      { size: 8, indent: 4, gap: 4.2 }
    );

    if (!r.hasData) {
      para("Rigging: no rigging data for this enclosure.", { size: 8, gray: 120, indent: 4, gap: 4.2 });
    } else if (r.noRigging) {
      para("Rigging: ground-stacked — no rigging hardware (on the floor).", { size: 8, gray: 90, indent: 4, gap: 4.2 });
    } else if (r.frame) {
      para(
        `Rigging: 1× ${r.frame.code} — ${r.frame.name} (${fmtWeight(r.frameWeightKg, weightInLbs)})${r.frame.wll ? `  ·  ${r.frame.wll}` : ""}`,
        { size: 8, indent: 4, gap: 4.2 }
      );
      if (r.optionalParts.length > 0) {
        const opt = r.optionalParts
          .map((p) => `${p.code} (${fmtWeight(typeof p.weight_kg === "number" ? p.weight_kg : null, weightInLbs)})`)
          .join(", ");
        para(`Optional / situational (qty per manual): ${opt}`, { size: 7.5, gray: 120, indent: 6, gap: 3.8 });
      }
    }

    if (r.manualUrl) {
      doc.setFontSize(7);
      doc.setTextColor(40, 90, 200);
      ensure(4);
      doc.textWithLink("rigging manual >", MARGIN + 4, yPos, { url: r.manualUrl });
      doc.setTextColor(0);
      yPos += 4.5;
    }
    yPos += 2;
  };

  // ---- per-zone detail -------------------------------------------------------
  model.zones.forEach((zone, zi) => {
    if (isMultiZone) {
      doc.addPage();
      yPos = MARGIN;
    } else {
      ensure(20);
    }
    heading(isMultiZone ? `Zone ${zi + 1} — ${zone.name}` : "Zone Detail");

    zone.arrays.forEach((arr, ai) => renderArray(arr, ai + 1));

    // Amplification
    ensure(12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Amplification", MARGIN, yPos);
    yPos += 5;
    const ampGroups = new Map<string, AmpInstance[]>();
    for (const amp of zone.amps) {
      const key = amp.ampConfig.model + (amp.ampConfig.mode ? ` (${amp.ampConfig.mode})` : "");
      if (!ampGroups.has(key)) ampGroups.set(key, []);
      ampGroups.get(key)!.push(amp);
    }
    if (ampGroups.size === 0) {
      para("No amplifiers allocated.", { size: 8, gray: 110, indent: 3 });
    }
    const cablingById = new Map(zone.cabling.map((c) => [c.ampId, c]));
    for (const [label, amps] of ampGroups) {
      const phys = physicalEnclosureTotals(amps);
      const load = [...phys.entries()].map(([nm, q]) => `${q}× ${nm}`).join(", ");
      para(`${amps.length}× ${label}  —  ${load || "—"}`, { size: 9, indent: 3, gap: 4.6 });

      // Per-amp-group cabling (aggregated per connector across this model's amps).
      const acs = amps.map((a) => cablingById.get(a.id)).filter((c): c is NonNullable<typeof c> => !!c);
      if (acs.length > 0) {
        const rep = acs[0];
        const tails = new Map<string, number>();
        const jumpers = new Map<string, number>();
        const ysplits = new Map<string, number>();
        const merge = (dst: Map<string, number>, src: Map<string, number>) => {
          for (const [k, n] of src) dst.set(k, (dst.get(k) ?? 0) + n);
        };
        let looms = 0;
        let loomBreakout: string | undefined;
        let minImp: number | null = null;
        for (const c of acs) {
          if (c.isLA12X) { looms += 1; loomBreakout = c.breakout ?? loomBreakout; }
          const t = tallyAmpCables(c);
          merge(tails, t.tails);
          merge(jumpers, t.jumpers);
          merge(ysplits, t.ysplits);
          if (c.minImpedanceOhms != null) minImp = minImp == null ? c.minImpedanceOhms : Math.min(minImp, c.minImpedanceOhms);
        }
        const repMax = acs.find((c) => c.minImpedanceOhms === minImp);
        const parts: string[] = [];
        if (looms > 0) parts.push(`${looms}× NL8 -> ${loomBreakout ?? "NL4"} loom`);
        for (const [k, n] of tails) parts.push(`${n}× ${k} amp tail`);
        for (const [k, n] of jumpers) parts.push(`${n}× ${k} jumper`);
        for (const [k, n] of ysplits) parts.push(`${n}× ${k} Y-split`);
        let tail = `; ${rep.gaugeMm2} mm² (AWG ${rep.gaugeAwg})`;
        if (minImp != null && repMax) {
          const len = useFeet ? `${repMax.maxLenFeet} ft` : `${repMax.maxLenMeters} m`;
          tail += `, max ${len} @ ${minImp} ohm${repMax.maxLenEstimated ? " (est.)" : ""}`;
        }
        if (parts.length > 0) para(`Cabling: ${parts.join(", ")}${tail}`, { size: 8, gray: 70, indent: 5, gap: 4 });
      }
    }
    const hasLA12X = zone.amps.some((a) => a.ampConfig.key === "LA12X");
    const rakNote = hasLA12X
      ? rackMode
        ? "Configured as LA-RAK: LA12X rack 3 per LA-RAK; cabling shown as the service-amp NL8 loom per amp."
        : "LA12X shown solo (per-channel cabling). Turn on LA-RAK mode to rack them and use service-amp NL8 looms."
      : "No LA12X in this zone — LA-RAK grouping N/A.";
    para(rakNote, { size: 7.5, gray: 120, indent: 3, gap: 4 });
    yPos += 3;

    // Zone weight roll-up
    ensure(16);
    doc.setFillColor(238, 238, 238);
    doc.rect(MARGIN, yPos - 3.5, CONTENT_WIDTH, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text(
      `Zone weight: ${fmtWeight(zone.zoneWeightKg, weightInLbs)}${zone.weightIsLowerBound ? "+" : ""}  (loudspeakers ${fmtWeight(zone.loudspeakerKg, weightInLbs)} + rigging ${fmtWeight(zone.riggingKg, weightInLbs)}, excl. amps)`,
      MARGIN + 3,
      yPos + 1
    );
    yPos += 8;

    // Rigging-load summary for flown arrays (for the rigger)
    const flown = zone.arrays.filter((a) => a.rigging.frame && a.rigging.deploymentMode === "flown");
    if (flown.length > 0) {
      ensure(8);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.text("Rigging load (flown arrays)", MARGIN, yPos);
      yPos += 4.5;
      for (const a of flown) {
        const r = a.rigging;
        para(
          `${r.encName}: ${fmtWeight(r.arrayWeightKg, weightInLbs)}${r.arrayWeightIsLowerBound ? "+" : ""} on 1× ${r.frame!.code}${r.frame!.wll ? ` (${r.frame!.wll})` : ""}`,
          { size: 7.5, gray: 60, indent: 3, gap: 4 }
        );
      }
      para("Motor / point selection is not derivable from the data — rigger to confirm.", { size: 7, gray: 130, indent: 3, gap: 3.6 });
      yPos += 2;
    }
  });

  // ---- footer: manuals, assumptions, signatures ------------------------------
  ensure(30);
  yPos += 2;
  heading("Reference & Sign-off", 11);
  if (model.manuals.size > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("Rigging manuals:", MARGIN, yPos);
    yPos += 4.5;
    for (const [enc, url] of model.manuals) {
      ensure(4.5);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(0);
      doc.text(`${enc}: `, MARGIN + 3, yPos);
      const lx = MARGIN + 3 + doc.getTextWidth(`${enc}: `);
      doc.setTextColor(40, 90, 200);
      doc.textWithLink(fit(url, PAGE_WIDTH - MARGIN - lx), lx, yPos, { url });
      doc.setTextColor(0);
      yPos += 4.2;
    }
    yPos += 2;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(150, 90, 0);
  ensure(6);
  doc.text("Confirm / not in data:", MARGIN, yPos);
  doc.setTextColor(0);
  yPos += 4.5;
  for (const note of model.assumptions) {
    para(`• ${note}`, { size: 7.5, gray: 90, indent: 3, gap: 3.8 });
  }
  yPos += 6;

  ensure(10);
  doc.setDrawColor(160);
  const third = CONTENT_WIDTH / 3;
  doc.line(MARGIN, yPos, MARGIN + third - 6, yPos);
  doc.line(MARGIN + third, yPos, MARGIN + 2 * third - 6, yPos);
  doc.line(MARGIN + 2 * third, yPos, PAGE_WIDTH - MARGIN, yPos);
  yPos += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(110);
  doc.text("Pulled by", MARGIN, yPos);
  doc.text("Checked by", MARGIN + third, yPos);
  doc.text("Date", MARGIN + 2 * third, yPos);
  doc.setTextColor(0);

  doc.save(`pull-sheet-${new Date().toISOString().split("T")[0]}.pdf`);
}
