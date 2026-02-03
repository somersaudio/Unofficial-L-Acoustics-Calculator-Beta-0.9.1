import type { Zone, ZoneSerialized, Enclosure, AmpConfig, AmpInstance, AmpInstanceSerialized } from "../types";

/** Serialize an amp instance for JSON storage */
function serializeAmpInstance(instance: AmpInstance): AmpInstanceSerialized {
  return {
    id: instance.id,
    ampConfigKey: instance.ampConfig.key,
    outputs: instance.outputs.map((output) => ({
      outputIndex: output.outputIndex,
      enclosures: output.enclosures.map((e) => ({
        enclosureName: e.enclosure.enclosure,
        count: e.count,
      })),
    })),
  };
}

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
    lockedAmpInstances: zone.lockedAmpInstances.map(serializeAmpInstance),
  }));
}

/** Deserialize an amp instance from JSON */
function deserializeAmpInstance(
  serialized: AmpInstanceSerialized,
  enclosureMap: Map<string, Enclosure>,
  ampConfigMap: Map<string, AmpConfig>
): AmpInstance | null {
  const ampConfig = ampConfigMap.get(serialized.ampConfigKey);
  if (!ampConfig) return null;

  const outputs = serialized.outputs.map((output) => {
    const enclosures = output.enclosures
      .map((e) => {
        const enclosure = enclosureMap.get(e.enclosureName);
        if (!enclosure) return null;
        return { enclosure, count: e.count };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const totalEnclosures = enclosures.reduce((sum, e) => sum + e.count, 0);

    // Calculate impedance for this output
    let impedanceOhms = Infinity;
    if (totalEnclosures > 0) {
      // Sum conductance (1/R) for parallel enclosures
      let totalConductance = 0;
      for (const e of enclosures) {
        totalConductance += e.count / e.enclosure.nominal_impedance_ohms;
      }
      impedanceOhms = totalConductance > 0 ? 1 / totalConductance : Infinity;
    }

    return {
      outputIndex: output.outputIndex,
      enclosures,
      totalEnclosures,
      impedanceOhms,
    };
  });

  const totalEnclosures = outputs.reduce((sum, o) => sum + o.totalEnclosures, 0);
  const loadPercent = Math.round((totalEnclosures / (ampConfig.outputs * 4)) * 100); // Rough estimate

  return {
    id: serialized.id,
    ampConfig,
    outputs,
    totalEnclosures,
    loadPercent,
  };
}

/** Deserialize zones from JSON, resolving enclosure names against the loaded data catalog */
export function deserializeZones(
  serialized: ZoneSerialized[],
  enclosureCatalog: Enclosure[],
  ampConfigs?: AmpConfig[]
): Zone[] {
  const enclosureMap = new Map(enclosureCatalog.map((e) => [e.enclosure, e]));
  const ampConfigMap = new Map((ampConfigs ?? []).map((a) => [a.key, a]));

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
    lockedAmpInstances: (sz.lockedAmpInstances ?? [])
      .map((ai) => deserializeAmpInstance(ai, enclosureMap, ampConfigMap))
      .filter((ai): ai is NonNullable<typeof ai> => ai !== null),
  }));
}
