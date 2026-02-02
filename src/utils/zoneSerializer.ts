import type { Zone, ZoneSerialized, Enclosure } from "../types";

/** Serialize zones for JSON storage (localStorage or file) */
export function serializeZones(zones: Zone[]): ZoneSerialized[] {
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    requests: zone.requests.map((r) => ({
      enclosureName: r.enclosure.enclosure,
      quantity: r.quantity,
    })),
    disabledAmps: Array.from(zone.disabledAmps),
  }));
}

/** Deserialize zones from JSON, resolving enclosure names against the loaded data catalog */
export function deserializeZones(
  serialized: ZoneSerialized[],
  enclosureCatalog: Enclosure[]
): Zone[] {
  const enclosureMap = new Map(enclosureCatalog.map((e) => [e.enclosure, e]));

  return serialized.map((sz) => ({
    id: sz.id,
    name: sz.name,
    requests: sz.requests
      .map((r) => {
        const enclosure = enclosureMap.get(r.enclosureName);
        if (!enclosure) return null;
        return { enclosure, quantity: r.quantity };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
    disabledAmps: new Set(sz.disabledAmps),
  }));
}
