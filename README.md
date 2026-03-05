# Unofficial L-Acoustics Calculator Beta 0.9.1

**Built from L-Acoustics' own amplifier and enclosure specifications**, this professional audio engineering tool automatically solves amplifier-to-enclosure matching with real-time impedance validation, cable loss frequency analysis, and intelligent LA-RAK grouping across multi-zone deployments. Per-output signal routing, damping factor analysis, and one-click PDF reports.

**Author:** somersaudio
**Version:** 0.9.1
**License:** Proprietary — All rights reserved

---

## Supported Hardware

### Amplifiers (5 Models)

| Model | Outputs | Notes |
|-------|---------|-------|
| **LA4** | 4 | Basic model |
| **LA2Xi** | 4 | SE, BTL, PBTL operating modes |
| **LA4X** | 4 | Enhanced LA4 |
| **LA12X** | 4 channels / 2 physical | High-power professional |
| **LA7.16(i)** | 16 channels | Multi-channel touring amp, SC32 connector support |

### Enclosures (45+ Models)

- **K-Series** — K1, K1-SB, K2, K3, K3i, KS21, KS21i, KS28, Kara II, Kara IIi, Kiva, Kiva II
- **A-Series** — A10/A10i Wide & Focus, A15/A15i Wide & Focus
- **X-Series** — X4i, X6i, X8, X8i, X12, X15 HiQ
- **S-Series** — SB6i, SB10i, SB15m, SB18/SB18 IIi, SB118, Kilo
- **Syva System** — Syva, Syva Low, Syva Low Syva (hybrid), Syva Sub
- **L2/L2D** — Large format line array (16-channel)
- **Soka** — Compact installation
- **Legacy** — ARCS Wide/Focus, 5XT, 8XT, 12XT, 115XT, 112XT, MTD series

---

## Features

### Core Engine
- **Automatic Amplifier Allocation** — Intelligently assigns enclosures to amp outputs based on impedance constraints, channel requirements, and per-amplifier limits
- **Real-Time Impedance Validation** — Enforces minimum 2.55Ω hard floor with tolerance, flags errors for over/under limits
- **Multi-Zone Support** — Independent calculation zones for complex system deployments
- **LA-RAK Mode** — Rack-mounted amplifier grouping with per-output multipliers (×N per channel)
- **Amp Locking** — Preserve manual configurations by locking individual amplifiers

### Cable Analysis
- **Frequency-Dependent Cable Loss Chart** — Interactive visualization showing loss curves per output across the frequency spectrum
- **Cable Length Calculator** — Configurable lengths with gauge selection (1.5, 2.5, 4, 6 mm²)
- **Impedance-Based Cable Recommendations** — Smart max cable length limits derived from load impedance
- **Damping Factor Display** — Shows cable effect on amplifier damping per output
- **Unit Toggle** — Meters / feet preference

### Signal Routing
- **Per-Output Cable Chain Visualization** — Shows the full physical cable path: amp connector → breakout → enclosures → daisy-chain
- **Connector Intelligence** — Automatically determines NL2, NL4, NL8, or SC32 based on amp model and channel configuration
- **Multi-Channel Matching** — Properly routes LF/MF/HF signal types for multi-way enclosures (K1, K2, K3)

### Reporting & Persistence
- **PDF Export** — One-click professional project reports
- **Project Save/Load** — Serialize configurations to `.lacalc` files (File → Open/Save, ⌘O/⌘S)
- **Sales Mode** — Simplified view for non-technical presentations

### Visual
- **Enclosure Images** — Product photos for 58+ enclosure variants
- **Color-Coded Outputs** — Distinct colors per output channel across charts and labels
- **Dark Mode** — Full dark/light theme with custom color system
- **Matrix Rain** — Animated L-Acoustics-themed background effect (dark mode)
- **Frequency Hemisphere** — Visual indicator of lowest frequency in the active zone

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Electron 40 |
| UI Framework | React 19 |
| Build Tool | Vite 5 |
| Language | TypeScript |
| Styling | Tailwind CSS 4 |
| PDF Generation | jsPDF |
| Packaging | Electron Forge 7 |
| Code Quality | ESLint |

### Distribution
- **macOS** — Apple Developer ID signed & notarized, ZIP distribution
- **Windows** — Squirrel installer
- **Linux** — RPM / DEB packages

---

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm start

# Build distributable
npm run make

# Package without installer
npm run package

# Lint
npm run lint
```

### Window Defaults
- **Size:** 1645 × 800 px
- **Minimum:** 900 × 600 px

---

## Project Structure

```
├── data/
│   ├── Amplifiers.json           # Amp specs, wiring modes, output configs
│   ├── Enclosures.json           # 45+ enclosures with impedance & limits
│   └── Load Tables.json          # Load percentage calculations
│
├── src/
│   ├── main.ts                   # Electron main process, IPC, native menu
│   ├── preload.ts                # Secure IPC bridge (contextBridge)
│   ├── renderer.tsx              # React entry point
│   ├── index.css                 # Tailwind + light/dark theme overrides
│   │
│   ├── components/
│   │   ├── App.tsx               # Main app shell, settings, header/footer
│   │   ├── SolverResults.tsx     # Amp allocation results & output cards
│   │   ├── EnclosureSelector.tsx # Left panel enclosure picker
│   │   ├── CableLossChart.tsx    # Frequency-dependent loss visualization
│   │   ├── ZoneTabBar.tsx        # Multi-zone tab navigation
│   │   ├── EnclosureDragDrop.tsx # Drag-drop enclosure management
│   │   └── MatrixRain.tsx        # Animated background effect
│   │
│   ├── solver/
│   │   └── ampSolver.ts          # Core allocation & impedance logic
│   │
│   ├── utils/
│   │   ├── impedanceModel.ts     # Cable loss & damping calculations
│   │   ├── pdfExport.ts          # PDF report generation
│   │   ├── enclosureImages.ts    # Enclosure image mapping
│   │   ├── frequencyData.ts      # Frequency analysis utilities
│   │   └── zoneSerializer.ts     # Project save/load serialization
│   │
│   ├── types/index.ts            # Complete TypeScript definitions
│   └── assets/                   # Logo, images
│
├── forge.config.ts               # Electron Forge build config
├── vite.main.config.mts          # Vite main process config
└── vite.renderer.config.mts      # Vite renderer config
```

---

## Validation & Safety

- **Impedance Floor** — Hard minimum 2.55Ω prevents unsafe amplifier loading
- **Parallel Wiring Constraints** — Per-enclosure parallel limits enforced
- **Amp/Enclosure Compatibility** — Cross-reference validation ensures only valid combinations
- **Impedance Section Overrides** — Handles special cases (e.g., K2 HF at 16Ω)
- **Load Percentage Warnings** — Traffic-light indicators (green/amber/red) for load %, cable loss, and damping factor
