/**
 * Low frequency limits for L-Acoustics enclosures (in Hz)
 * Data sourced from L-Acoustics preset guides
 */
export const ENCLOSURE_LOW_FREQUENCY: Record<string, number> = {
  // Main speakers (names must match Enclosures.json exactly)
  "L2 / L2D": 45,
  "K1": 35,
  "K2": 35,
  "K3": 42,
  "K3i": 42,
  "Kara II": 55,
  "Kara IIi": 55,
  "A15 Wide/Focus": 41,
  "A15i Wide/Focus": 41,
  "A10 Wide/Focus": 66,
  "A10i Wide/Focus": 66,
  "X15 HiQ": 42,
  "X12": 59,
  "X8": 60,
  "X8i": 43,
  "X6i": 54,
  "X4i": 120,
  "5XT": 95,
  "Syva": 87,
  "Soka": 52,

  // Subwoofers
  "KS28": 25,
  "SB10i": 25,
  "Syva Sub": 27,
  "KS21": 29,
  "KS21i": 29,
  "SB6i": 29,
  "K1-SB": 30,
  "SB18 / SB18 IIi": 32,
  "SB15m": 40,
  "Syva Low": 40,

  // Legacy
  "Kiva": 55,
  "Kiva II": 55,
  "Kilo": 40,
  "SB118": 37,
  "8XT": 85,
  "12XT (Active)": 62,
  "12XT (Passive)": 62,
  "115XT HiQ": 42,
  "112XT": 55,
  "115XT": 45,
  "MTD108a": 75,
  "MTD112b": 55,
  "MTD115b (Active)": 40,
  "MTD115b (Passive)": 40,
  "ARCS Wide/Focus": 50,
  "ARCS": 55,
};

/**
 * Get the lowest frequency from a list of enclosure names
 */
export function getLowestFrequency(enclosureNames: string[]): number | null {
  if (enclosureNames.length === 0) return null;

  let lowest = Infinity;
  for (const name of enclosureNames) {
    const freq = ENCLOSURE_LOW_FREQUENCY[name];
    if (freq !== undefined && freq < lowest) {
      lowest = freq;
    }
  }

  return lowest === Infinity ? null : lowest;
}
