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
        sourceArrayId: e.sourceArrayId,
      })),
    })),
    rackGroupId: instance.rackGroupId,
  };
}

/** Serialize zones for JSON storage (localStorage or file) */
export function serializeZones(zones: Zone[]): ZoneSerialized[] {
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    requests: zone.requests.map((r) => ({
      id: r.id,
      enclosureName: r.enclosure.enclosure,
      quantity: r.quantity,
      perOutput: r.perOutput,
      locked: r.locked,
      deploymentMode: r.deploymentMode,
      riggingCode: r.riggingCode,
      dedicatedAmp: r.dedicatedAmp,
    })),
    disabledAmps: Array.from(zone.disabledAmps),
    lockedAmpInstances: zone.lockedAmpInstances.map(serializeAmpInstance),
    ampSharingMode: zone.ampSharingMode,
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
        return { enclosure, count: e.count, sourceArrayId: e.sourceArrayId };
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
    rackGroupId: serialized.rackGroupId,
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

  const zones: Zone[] = serialized.map((sz) => ({
    id: sz.id,
    name: sz.name,
    requests: sz.requests
      .map((r) => {
        const enclosure = enclosureMap.get(r.enclosureName);
        if (!enclosure) return null;
        return { id: r.id ?? crypto.randomUUID(), enclosure, quantity: r.quantity, perOutput: r.perOutput, locked: r.locked, deploymentMode: r.deploymentMode, riggingCode: r.riggingCode, dedicatedAmp: r.dedicatedAmp };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
    ampSharingMode: sz.ampSharingMode,
    disabledAmps: new Set(sz.disabledAmps),
    lockedAmpInstances: (sz.lockedAmpInstances ?? [])
      .map((ai) => deserializeAmpInstance(ai, enclosureMap, ampConfigMap))
      .filter((ai): ai is NonNullable<typeof ai> => ai !== null),
  }));

  // Migration: amps locked before source-array provenance existed have no sourceArrayId.
  // Attribute each unstamped entry's count to this zone's same-type arrays (unlocked rows
  // first, matching the old distribution), splitting an entry that spans multiple arrays —
  // so old projects load with exact per-array locked counts and don't double-count.
  for (const zone of zones) {
    const needsBackfill = zone.lockedAmpInstances.some((amp) =>
      amp.outputs.some((o) => o.enclosures.some((e) => e.sourceArrayId === undefined))
    );
    if (!needsBackfill) continue;
    const slotsByName = new Map<string, Array<{ id: string; remaining: number }>>();
    for (const req of [...zone.requests].sort((a, b) => Number(Boolean(a.locked)) - Number(Boolean(b.locked)))) {
      const list = slotsByName.get(req.enclosure.enclosure) ?? [];
      list.push({ id: req.id, remaining: req.quantity });
      slotsByName.set(req.enclosure.enclosure, list);
    }
    for (const amp of zone.lockedAmpInstances) {
      for (const output of amp.outputs) {
        const rebuilt: typeof output.enclosures = [];
        for (const entry of output.enclosures) {
          if (entry.sourceArrayId !== undefined) { rebuilt.push(entry); continue; }
          let left = entry.count;
          for (const slot of slotsByName.get(entry.enclosure.enclosure) ?? []) {
            if (left <= 0) break;
            if (slot.remaining <= 0) continue;
            const take = Math.min(left, slot.remaining);
            rebuilt.push({ enclosure: entry.enclosure, count: take, sourceArrayId: slot.id });
            slot.remaining -= take;
            left -= take;
          }
          if (left > 0) rebuilt.push({ enclosure: entry.enclosure, count: left }); // no matching row — leave unattributed
        }
        output.enclosures = rebuilt;
      }
    }
  }

  return zones;
}
