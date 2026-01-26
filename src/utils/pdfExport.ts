import { jsPDF } from "jspdf";
import type { SolverSolution, EnclosureRequest } from "../types";

const PAGE_WIDTH = 210; // A4 width in mm
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

interface PDFExportOptions {
  solution: SolverSolution;
  requests: EnclosureRequest[];
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
  const { solution, requests } = options;

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  let yPos = MARGIN;

  // Logo
  try {
    const logo = await loadImageWithDimensions("data/lacoustics-logo.png");
    // Calculate width from actual aspect ratio to avoid stretching
    const logoHeight = 8;
    const aspectRatio = logo.width / logo.height;
    const logoWidth = logoHeight * aspectRatio;
    doc.addImage(logo.base64, "PNG", MARGIN, yPos - 4, logoWidth, logoHeight);
    yPos += 10;
  } catch {
    // Fallback to text if logo fails to load
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

  if (!solution.success) {
    doc.setFontSize(12);
    doc.setTextColor(200, 0, 0);
    doc.text("Error: " + (solution.errorMessage || "Unknown error"), MARGIN, yPos);
    doc.save("amp-config-report.pdf");
    return;
  }

  // Enclosure Requests Section
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Enclosure Requests", MARGIN, yPos);
  yPos += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  for (const request of requests) {
    doc.text(`• ${request.quantity}x ${request.enclosure.enclosure}`, MARGIN + 3, yPos);
    yPos += 5;
  }

  yPos += 8;

  // Amplifier Details
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Amplification Request", MARGIN, yPos);
  yPos += 8;

  // Group amp instances by config key
  const ampGroups = new Map<string, typeof solution.ampInstances>();
  for (const amp of solution.ampInstances) {
    const key = amp.ampConfig.key;
    if (!ampGroups.has(key)) {
      ampGroups.set(key, []);
    }
    ampGroups.get(key)!.push(amp);
  }

  for (const [, amps] of ampGroups) {
    // Check for page break
    if (yPos > 260) {
      doc.addPage();
      yPos = MARGIN;
    }

    const firstAmp = amps[0];
    const count = amps.length;

    // Amp header with count
    doc.setFillColor(245, 245, 245);
    doc.rect(MARGIN, yPos - 4, CONTENT_WIDTH, 8, "F");
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    const ampLabel = `${firstAmp.ampConfig.model}${firstAmp.ampConfig.mode ? " (" + firstAmp.ampConfig.mode + ")" : ""}${count > 1 ? ` (${count}×)` : ""}`;
    doc.text(ampLabel, MARGIN + 3, yPos);

    // Total amplifiers on right
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

    // List enclosure totals
    doc.setFontSize(9);
    for (const [encName, encCount] of enclosureTotals) {
      doc.text(`  ${encCount}x ${encName}`, MARGIN + 3, yPos);
      yPos += 4.5;
    }

    yPos += 6;
  }

  // Save the PDF
  const filename = `amp-config-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(filename);
}
