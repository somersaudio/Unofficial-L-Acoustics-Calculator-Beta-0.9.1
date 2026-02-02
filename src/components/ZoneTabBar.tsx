import React, { useState, useRef, useEffect } from "react";
import type { Zone } from "../types";

interface ZoneTabBarProps {
  zones: Zone[];
  activeZoneId: string;
  onSelectZone: (id: string) => void;
  onAddZone: () => void;
  onRemoveZone: (id: string) => void;
  onRenameZone: (id: string, name: string) => void;
}

export default function ZoneTabBar({
  zones,
  activeZoneId,
  onSelectZone,
  onAddZone,
  onRemoveZone,
  onRenameZone,
}: ZoneTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEditing = (zone: Zone) => {
    setEditingId(zone.id);
    setEditValue(zone.name);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRenameZone(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleRemove = (e: React.MouseEvent, zoneId: string) => {
    e.stopPropagation();
    const zone = zones.find((z) => z.id === zoneId);
    if (zone && zone.requests.length > 0) {
      if (!confirm(`Remove "${zone.name}"? It has ${zone.requests.length} enclosure(s).`)) {
        return;
      }
    }
    onRemoveZone(zoneId);
  };

  return (
    <div className="flex items-center border-b border-gray-200 bg-gray-50 px-4 dark:border-neutral-800 dark:bg-neutral-950">
      {zones.map((zone) => {
        const isActive = zone.id === activeZoneId;
        const isEditing = editingId === zone.id;

        return (
          <div
            key={zone.id}
            onClick={() => onSelectZone(zone.id)}
            onDoubleClick={() => startEditing(zone)}
            className={`group relative flex cursor-pointer items-center gap-1 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "border-blue-600 text-blue-700 dark:border-blue-500 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-neutral-500 dark:hover:border-neutral-600 dark:hover:text-neutral-300"
            }`}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="w-20 rounded border border-blue-400 bg-white px-1 py-0 text-sm dark:border-blue-600 dark:bg-neutral-800 dark:text-gray-200"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span>{zone.name}</span>
            )}
            {zones.length > 1 && !isEditing && (
              <button
                onClick={(e) => handleRemove(e, zone.id)}
                className="ml-1 hidden rounded text-gray-400 hover:text-red-500 group-hover:inline-block dark:text-neutral-600 dark:hover:text-red-400"
                title={`Remove ${zone.name}`}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        );
      })}

      {/* Add Zone Button */}
      <button
        onClick={onAddZone}
        className="ml-1 rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        title="Add zone"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}
