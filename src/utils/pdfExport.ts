import { jsPDF } from "jspdf";
import type { ZoneWithSolution } from "../types";
import lacousticsLogo from "../assets/lacoustics-logo.png";

const PAGE_WIDTH = 210; // A4 width in mm
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

interface PDFExportOptions {
  zoneSolutions: ZoneWithSolution[];
  rackMode?: boolean;
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
      resolve({
        base64: canvas.toDataURL("image/png"),
        width: img.width,
        height: img.height,
      });
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

export async function generatePDFReport(options: PDFExportOptions): Promise<void> {
  const { zoneSolutions } = options;
  const isMultiZone = zoneSolutions.length > 1;

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  let yPos = MARGIN;

  // Logo
  try {
    const logo = await loadImageWithDimensions(lacousticsLogo);
    const logoHeight = 8;
    const aspectRatio = logo.width / logo.height;
    const logoWidth = logoHeight * aspectRatio;
    doc.addImage(logo.base64, "PNG", MARGIN, yPos - 4, logoWidth, logoHeight);
    yPos += 10;
  } catch {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("L-Acoustics", MARGIN, yPos);
    yPos += 10;
  }

  // Date
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, MARGIN, yPos);
  doc.setTextColor(0);
  yPos += 12;

  // Helper: ensure page break if needed
  const ensureSpace = (needed: number) => {
    if (yPos + needed > 280) {
      doc.addPage();
      yPos = MARGIN;
    }
  };

  // Render each zone
  for (const zs of zoneSolutions) {
    const { zone, solution } = zs;
    if (!solution) continue;

    // Zone header (multi-zone only)
    if (isMultiZone) {
      ensureSpace(20);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0);
      doc.text(zone.name, MARGIN, yPos);
      yPos += 2;
      doc.setDrawColor(180);
      doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
      yPos += 8;
    }

    if (!solution.success) {
      doc.setFontSize(12);
      doc.setTextColor(200, 0, 0);
      doc.text("Error: " + (solution.errorMessage || "Unknown error"), MARGIN, yPos);
      doc.setTextColor(0);
      yPos += 10;
      continue;
    }

    // Enclosure Requests
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0);
    doc.text("Enclosure Requests", MARGIN, yPos);
    yPos += 6;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    for (const request of zone.requests) {
      doc.text(`• ${request.quantity}x ${request.enclosure.enclosure}`, MARGIN + 3, yPos);
      yPos += 5;
    }
    yPos += 8;

    // Amplifier Details
    ensureSpace(15);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Amplification Request", MARGIN, yPos);
    yPos += 8;

    const RACK_SIZE = 3;

    // Separate LA12X amps (rackable) from others
    const la12xAmps = solution.ampInstances.filter(a => a.ampConfig.key === "LA12X");
    const otherAmps = solution.ampInstances.filter(a => a.ampConfig.key !== "LA12X");
    const showRacks = rackMode && la12xAmps.length > 0;

    if (showRacks) {
      // Group LA12X into racks by rackGroupId, then overflow racks of 3
      const rackGroups = new Map<string, typeof la12xAmps>();
      const ungrouped: typeof la12xAmps = [];
      for (const amp of la12xAmps) {
        if (amp.rackGroupId) {
          if (!rackGroups.has(amp.rackGroupId)) rackGroups.set(amp.rackGroupId, []);
          rackGroups.get(amp.rackGroupId)!.push(amp);
        } else {
          ungrouped.push(amp);
        }
      }
      // Build final rack list: explicit groups first, then chunk ungrouped into racks of 3
      const racks: (typeof la12xAmps)[] = [...rackGroups.values()];
      for (let i = 0; i < ungrouped.length; i += RACK_SIZE) {
        racks.push(ungrouped.slice(i, i + RACK_SIZE));
      }

      const totalAmps = la12xAmps.length;

      // Summary line: X LA-RAK(s), Y Amplifiers Total
      ensureSpace(12);
      doc.setFillColor(235, 235, 235);
      doc.rect(MARGIN, yPos - 4, CONTENT_WIDTH, 8, "F");
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(`${racks.length} LA-RAK${racks.length !== 1 ? "s" : ""}`, MARGIN + 3, yPos);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`${totalAmps} Amplifier${totalAmps !== 1 ? "s" : ""} Total`, PAGE_WIDTH - MARGIN - 3, yPos, { align: "right" });
      yPos += 8;

      // Each rack with its amps indented
      for (let rackIdx = 0; rackIdx < racks.length; rackIdx++) {
        const rackAmps = racks[rackIdx];
        ensureSpace(10 + rackAmps.length * 12);

        // Rack sub-header
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(80);
        doc.text(`LA-RAK #${rackIdx + 1}  (${rackAmps.length}/${RACK_SIZE} Amps)`, MARGIN + 5, yPos);
        doc.setTextColor(0);
        yPos += 6;

        // Each amp in this rack, indented
        for (const amp of rackAmps) {
          ensureSpace(12);
          doc.setFillColor(248, 248, 248);
          doc.rect(MARGIN + 8, yPos - 4, CONTENT_WIDTH - 8, 7, "F");
          doc.setFontSize(10);
          doc.setFont("helvetica", "bold");
          const ampLabel = `${amp.ampConfig.model}${amp.ampConfig.mode ? " (" + amp.ampConfig.mode + ")" : ""}`;
          doc.text(ampLabel, MARGIN + 11, yPos);
          yPos += 6;

          // Enclosures on this amp
          const enclosureTotals = new Map<string, number>();
          for (const output of amp.outputs) {
            for (const entry of output.enclosures) {
              enclosureTotals.set(entry.enclosure.enclosure, (enclosureTotals.get(entry.enclosure.enclosure) || 0) + entry.count);
            }
          }
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          for (const [encName, encCount] of enclosureTotals) {
            doc.text(`${encCount}x ${encName}`, MARGIN + 14, yPos);
            yPos += 4.5;
          }
          yPos += 2;
        }
        yPos += 3;
      }
    }

    // Non-LA12X amps (or all amps if not rack mode)
    const ampsToShow = showRacks ? otherAmps : solution.ampInstances;
    const otherGroups = new Map<string, typeof ampsToShow>();
    for (const amp of ampsToShow) {
      const key = amp.ampConfig.key;
      if (!otherGroups.has(key)) otherGroups.set(key, []);
      otherGroups.get(key)!.push(amp);
    }

    for (const [, amps] of otherGroups) {
      ensureSpace(20);

      const firstAmp = amps[0];
      const count = amps.length;

      doc.setFillColor(245, 245, 245);
      doc.rect(MARGIN, yPos - 4, CONTENT_WIDTH, 8, "F");
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      const ampLabel = `${firstAmp.ampConfig.model}${firstAmp.ampConfig.mode ? " (" + firstAmp.ampConfig.mode + ")" : ""}${count > 1 ? ` (${count}×)` : ""}`;
      doc.text(ampLabel, MARGIN + 3, yPos);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      const loadText = `${count} Amplifier${count !== 1 ? "s" : ""} Total`;
      doc.text(loadText, PAGE_WIDTH - MARGIN - 3, yPos, { align: "right" });
      yPos += 8;

      // Aggregate enclosures across all instances of this amp type
      const enclosureTotals = new Map<string, number>();
      for (const amp of amps) {
        for (const output of amp.outputs) {
          for (const entry of output.enclosures) {
            const encName = entry.enclosure.enclosure;
            enclosureTotals.set(encName, (enclosureTotals.get(encName) || 0) + entry.count);
          }
        }
      }

      doc.setFontSize(9);
      for (const [encName, encCount] of enclosureTotals) {
        doc.text(`  ${encCount}x ${encName}`, MARGIN + 3, yPos);
        yPos += 4.5;
      }
      yPos += 6;
    }

    yPos += 4;
  }

  // Grand total (multi-zone only)
  if (isMultiZone) {
    ensureSpace(25);
    doc.setDrawColor(100);
    doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
    yPos += 6;
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Grand Total", MARGIN, yPos);
    yPos += 8;

    const totalAmps = zoneSolutions.reduce((sum, zs) => sum + (zs.solution?.summary.totalAmplifiers ?? 0), 0);
    const totalEnc = zoneSolutions.reduce((sum, zs) => sum + (zs.solution?.summary.totalEnclosuresAllocated ?? 0), 0);

    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text(`Total Amplifiers: ${totalAmps}`, MARGIN + 3, yPos);
    yPos += 6;
    doc.text(`Total Enclosures: ${totalEnc}`, MARGIN + 3, yPos);
  }

  // Save the PDF
  const filename = `amp-config-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(filename);
}
