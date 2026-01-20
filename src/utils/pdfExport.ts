import { jsPDF } from "jspdf";
import type { SolverSolution, EnclosureRequest } from "../types";

const PAGE_WIDTH = 210; // A4 width in mm
const PAGE_HEIGHT = 297; // A4 height in mm
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

interface PDFExportOptions {
  solution: SolverSolution;
  requests: EnclosureRequest[];
  title?: string;
}

export function generatePDFReport(options: PDFExportOptions): void {
  const { solution, requests, title = "L-Acoustic Amplifier Configuration" } = options;

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  let yPos = MARGIN;

  // Helper to add new page if needed
  const checkNewPage = (neededSpace: number) => {
    if (yPos + neededSpace > PAGE_HEIGHT - MARGIN) {
      doc.addPage();
      yPos = MARGIN;
    }
  };

  // Title
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text(title, MARGIN, yPos);
  yPos += 10;

  // Date
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}`, MARGIN, yPos);
  yPos += 10;

  // Horizontal line
  doc.setDrawColor(200);
  doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
  yPos += 8;

  // Enclosure Request Summary
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Enclosure Requirements", MARGIN, yPos);
  yPos += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  for (const request of requests) {
    checkNewPage(6);
    const text = `${request.quantity}x ${request.enclosure.enclosure} (${request.enclosure.nominal_impedance_ohms}Ω${request.enclosure.parallelAllowed ? "" : ", no parallel"})`;
    doc.text(text, MARGIN + 5, yPos);
    yPos += 6;
  }

  const totalEnclosures = requests.reduce((sum, r) => sum + r.quantity, 0);
  yPos += 2;
  doc.setFont("helvetica", "bold");
  doc.text(`Total: ${totalEnclosures} enclosures`, MARGIN + 5, yPos);
  yPos += 12;

  // Solution Summary
  if (!solution.success) {
    doc.setFontSize(12);
    doc.setTextColor(200, 0, 0);
    doc.text("Error: " + (solution.errorMessage || "Unknown error"), MARGIN, yPos);
    doc.save("amp-config-report.pdf");
    return;
  }

  // Horizontal line
  doc.setDrawColor(200);
  doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
  yPos += 8;

  // Recommended Configuration Header
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 100, 0);
  doc.text("Recommended Configuration", MARGIN, yPos);
  yPos += 8;

  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.text(`Total Amplifiers Required: ${solution.summary.totalAmplifiers}`, MARGIN + 5, yPos);
  yPos += 6;

  const ampTypes = solution.summary.ampConfigsUsed
    .map((c) => c.model + (c.mode ? ` (${c.mode})` : ""))
    .join(", ");
  doc.setFont("helvetica", "normal");
  doc.text(`Amplifier Types: ${ampTypes}`, MARGIN + 5, yPos);
  yPos += 12;

  // Detailed Allocation
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Detailed Allocation", MARGIN, yPos);
  yPos += 10;

  for (const amp of solution.ampInstances) {
    checkNewPage(50);

    // Amp header box
    doc.setFillColor(240, 240, 240);
    doc.rect(MARGIN, yPos - 4, CONTENT_WIDTH, 10, "F");

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    const ampLabel = `${amp.ampConfig.model}${amp.ampConfig.mode ? " (" + amp.ampConfig.mode + ")" : ""} #${amp.id.split("-").pop()}`;
    doc.text(ampLabel, MARGIN + 3, yPos + 2);

    doc.setFont("helvetica", "normal");
    doc.text(`Load: ${amp.loadPercent}% | ${amp.totalEnclosures} enclosures`, MARGIN + 80, yPos + 2);
    yPos += 12;

    // Outputs table header
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Output", MARGIN + 5, yPos);
    doc.text("Enclosures", MARGIN + 30, yPos);
    doc.text("Impedance", MARGIN + 100, yPos);
    yPos += 5;

    // Outputs table rows
    doc.setFont("helvetica", "normal");
    for (const output of amp.outputs) {
      if (output.totalEnclosures === 0) continue;

      checkNewPage(6);

      const outputLabel = amp.ampConfig.outputs === 16
        ? `Ch ${output.outputIndex + 1}`
        : `Output ${output.outputIndex + 1}`;

      const enclosureText = output.enclosures
        .map((e) => `${e.count}x ${e.enclosure.enclosure}`)
        .join(", ");

      const impedanceText = output.impedanceOhms === Infinity
        ? "No load"
        : `${output.impedanceOhms}Ω`;

      // Color code impedance
      if (output.impedanceOhms < 2.7 && output.impedanceOhms !== Infinity) {
        doc.setTextColor(200, 0, 0); // Red for error
      } else {
        doc.setTextColor(0);
      }

      doc.text(outputLabel, MARGIN + 5, yPos);
      doc.setTextColor(0);
      doc.text(enclosureText, MARGIN + 30, yPos);

      if (output.impedanceOhms < 2.7 && output.impedanceOhms !== Infinity) {
        doc.setTextColor(200, 0, 0);
      }
      doc.text(impedanceText, MARGIN + 100, yPos);
      doc.setTextColor(0);

      yPos += 5;
    }

    yPos += 8;
  }

  // Footer
  checkNewPage(20);
  yPos = PAGE_HEIGHT - MARGIN - 10;
  doc.setDrawColor(200);
  doc.line(MARGIN, yPos, PAGE_WIDTH - MARGIN, yPos);
  yPos += 5;

  doc.setFontSize(8);
  doc.setTextColor(128);
  doc.text("Generated by L-Acoustic Amp Calc", MARGIN, yPos);
  doc.text("Page 1", PAGE_WIDTH - MARGIN - 15, yPos);

  // Save the PDF
  const filename = `amp-config-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(filename);
}
