/**
 * Enclosure image utilities
 * Maps enclosure names to their corresponding images
 */

// Import all available enclosure images
// Using Vite's import.meta.glob for dynamic imports
const imageModules = import.meta.glob('/Enclosure Images/*.png', { eager: true, as: 'url' });

// Manual aliases for images with non-standard filenames
// Maps normalized enclosure name -> { solo: filename, multi: filename }
// The values are normalized image base names (as they appear in imageMap)
const imageAliases: Record<string, { solo?: string; multi?: string }> = {
  // L2 / L2D
  'L2_L2D': {
    solo: 'Single-L2D-front-800x400-1',
    multi: 'L2',
  },
  // A-series: enclosure names have "Wide/Focus" but images are separate Wide/Focus files
  // Using Wide variant as default since images exist for both
  'A10Wide_Focus': { solo: 'A10Wide', multi: 'A10Wide' },
  'A10iWide_Focus': { solo: 'A10iWide', multi: 'A10iWide' },
  'A15Wide_Focus': { solo: 'A15Wide', multi: 'A15Wide' },
  'A15iWide_Focus': { solo: 'A15iWide', multi: 'A15iWide' },
  // Kiva II: solo image is "Kiva II.png", array is "KIVAII Array.png" (different case)
  'KivaII': { multi: 'KIVAII' },
  // SB18 / SB18 IIi: enclosure combines both, images are separate
  'SB18_SB18IIi': { solo: 'SB18', multi: 'SB18' },
};

// Build a map of normalized names to image URLs
const imageMap = new Map<string, { solo?: string; multi?: string }>();

for (const [path, url] of Object.entries(imageModules)) {
  // Extract filename without extension: "/Enclosure Images/Kara II Array.png" -> "Kara II Array"
  const filename = path.split('/').pop()?.replace('.png', '') ?? '';

  // Check if it's an array/multi image (new convention: "Name Array")
  const isArray = filename.endsWith(' Array');
  // Check if it's a solo image (old convention: "Name_Solo")
  const isSolo = filename.endsWith('_Solo');

  // Extract base name by removing the suffix
  let baseName = filename;
  if (isArray) {
    baseName = filename.replace(' Array', '');
  } else if (isSolo) {
    baseName = filename.replace('_Solo', '');
  }

  // Normalize the base name (remove spaces, etc.) for consistent lookup
  const normalizedBase = baseName
    .replace(/\s+/g, '')      // Remove spaces: "Kara II" -> "KaraII"
    .replace(/\//g, '_')       // Replace slashes: "Wide/Focus" -> "Wide_Focus"
    .replace(/\(|\)/g, '');    // Remove parentheses

  if (!imageMap.has(normalizedBase)) {
    imageMap.set(normalizedBase, {});
  }

  const entry = imageMap.get(normalizedBase)!;
  if (isArray) {
    // Array images are for multiple enclosures
    entry.multi = url as string;
  } else if (isSolo) {
    // Solo images are for single enclosure (old convention)
    entry.solo = url as string;
  } else {
    // Images without suffix are single enclosure images (new convention)
    // Only set as solo if we don't already have a solo image
    if (!entry.solo) {
      entry.solo = url as string;
    }
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

  // Check for direct match first
  let entry = imageMap.get(normalized);

  // Check for alias and merge with direct match
  if (imageAliases[normalized]) {
    const alias = imageAliases[normalized];
    // Build entry from aliased image names
    const soloEntry = alias.solo ? imageMap.get(alias.solo) : undefined;
    const multiEntry = alias.multi ? imageMap.get(alias.multi) : undefined;

    if (soloEntry || multiEntry) {
      const aliasedEntry = {
        solo: soloEntry?.solo ?? soloEntry?.multi,
        multi: multiEntry?.multi ?? multiEntry?.solo,
      };
      // Merge with existing entry (alias takes precedence for missing values)
      entry = {
        solo: entry?.solo ?? aliasedEntry.solo,
        multi: entry?.multi ?? aliasedEntry.multi,
      };
    }
  }

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
