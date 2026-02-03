/**
 * Enclosure image utilities
 * Maps enclosure names to their corresponding images
 */

// Import all available enclosure images
// Using Vite's import.meta.glob for dynamic imports
const imageModules = import.meta.glob('/Enclosure Images/*.png', { eager: true, as: 'url' });

// Build a map of normalized names to image URLs
const imageMap = new Map<string, { solo?: string; multi?: string }>();

for (const [path, url] of Object.entries(imageModules)) {
  // Extract filename without extension: "/Enclosure Images/KivaII_Solo.png" -> "KivaII_Solo"
  const filename = path.split('/').pop()?.replace('.png', '') ?? '';

  // Check if it's a solo image
  const isSolo = filename.endsWith('_Solo');
  const baseName = isSolo ? filename.replace('_Solo', '') : filename;

  if (!imageMap.has(baseName)) {
    imageMap.set(baseName, {});
  }

  const entry = imageMap.get(baseName)!;
  if (isSolo) {
    entry.solo = url as string;
  } else {
    entry.multi = url as string;
  }
}

/**
 * Normalize enclosure name to match image filename convention
 * e.g., "Kiva II" -> "KivaII", "A10 Wide/Focus" -> "A10Wide_Focus"
 */
function normalizeEnclosureName(name: string): string {
  return name
    .replace(/\s+/g, '')      // Remove spaces: "Kiva II" -> "KivaII"
    .replace(/\//g, '_')       // Replace slashes: "Wide/Focus" -> "Wide_Focus"
    .replace(/\(|\)/g, '')     // Remove parentheses: "(Active)" -> "Active"
}

/**
 * Get the image URL for an enclosure based on quantity
 * @param enclosureName - The enclosure name from data (e.g., "Kiva II", "KS28")
 * @param quantity - Number of enclosures (1 = solo, >1 = multi)
 * @returns Image URL or undefined if no image available
 */
export function getEnclosureImage(enclosureName: string, quantity: number = 1): string | undefined {
  const normalized = normalizeEnclosureName(enclosureName);
  const entry = imageMap.get(normalized);

  if (!entry) return undefined;

  // Return solo image for quantity 1, multi image otherwise
  // Fall back to the other variant if preferred isn't available
  if (quantity === 1) {
    return entry.solo ?? entry.multi;
  } else {
    return entry.multi ?? entry.solo;
  }
}

/**
 * Check if an enclosure has any images available
 */
export function hasEnclosureImage(enclosureName: string): boolean {
  const normalized = normalizeEnclosureName(enclosureName);
  return imageMap.has(normalized);
}

/**
 * Get all available enclosure images (for debugging)
 */
export function getAvailableImages(): Map<string, { solo?: string; multi?: string }> {
  return imageMap;
}
