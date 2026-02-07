import React, { useState, useCallback, createContext, useContext } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  pointerWithin,
} from "@dnd-kit/core";
import { getEnclosureImage } from "../utils/enclosureImages";

// =============================================================================
// Types
// =============================================================================

/** Data attached to a draggable enclosure item */
export interface DraggableEnclosureData {
  type: "enclosure";
  enclosureName: string;
  sourceAmpId: string;
  sourceChannelIndex: number;
  impedanceOhms: number;
}

/** Data attached to a droppable channel target */
export interface DroppableChannelData {
  type: "channel";
  ampId: string;
  ampModel: string;
  channelIndex: number;
  isLocked: boolean;
  currentEnclosures: Array<{ name: string; count: number }>;
}

/** Result of a drag operation */
export interface EnclosureMoveResult {
  enclosureName: string;
  sourceAmpId: string;
  sourceChannelIndex: number;
  targetAmpId: string;
  targetChannelIndex: number;
}

/** Validation result for a potential drop */
export interface DropValidation {
  isValid: boolean;
  requiresConfirmation: boolean;
  warningMessage?: string;
  errorMessage?: string;
}

// =============================================================================
// Context for drag state
// =============================================================================

interface EnclosureDragContextValue {
  isDragging: boolean;
  activeData: DraggableEnclosureData | null;
  overData: DroppableChannelData | null;
}

const EnclosureDragContext = createContext<EnclosureDragContextValue>({
  isDragging: false,
  activeData: null,
  overData: null,
});

export function useEnclosureDragState() {
  return useContext(EnclosureDragContext);
}

// =============================================================================
// Draggable Enclosure Hook
// =============================================================================

interface UseDraggableEnclosureOptions {
  enclosureName: string;
  ampId: string;
  channelIndex: number;
  impedanceOhms: number;
  isLocked: boolean;
  count: number;
}

export function useDraggableEnclosure({
  enclosureName,
  ampId,
  channelIndex,
  impedanceOhms,
  isLocked,
  count,
}: UseDraggableEnclosureOptions) {
  const id = `enclosure-${ampId}-${channelIndex}-${enclosureName}`;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: {
      type: "enclosure",
      enclosureName,
      sourceAmpId: ampId,
      sourceChannelIndex: channelIndex,
      impedanceOhms,
    } as DraggableEnclosureData,
    disabled: !isLocked || count === 0, // Only allow dragging FROM locked amps
  });

  return {
    ref: setNodeRef,
    isDragging,
    dragProps: { ...attributes, ...listeners },
    canDrag: isLocked && count > 0, // Can drag only if amp is locked
  };
}

// =============================================================================
// Droppable Channel Hook
// =============================================================================

interface UseDroppableChannelOptions {
  ampId: string;
  ampModel: string;
  channelIndex: number;
  isLocked: boolean;
  currentEnclosures: Array<{ name: string; count: number }>;
}

export function useDroppableChannel({
  ampId,
  ampModel,
  channelIndex,
  isLocked,
  currentEnclosures,
}: UseDroppableChannelOptions) {
  const id = `channel-${ampId}-${channelIndex}`;

  const { setNodeRef, isOver, active } = useDroppable({
    id,
    data: {
      type: "channel",
      ampId,
      ampModel,
      channelIndex,
      isLocked,
      currentEnclosures,
    } as DroppableChannelData,
    disabled: !isLocked, // Only allow dropping TO locked amps
  });

  // Check if this is a valid drop target for the current drag
  const activeData = active?.data.current as DraggableEnclosureData | undefined;
  const isSameSource = activeData &&
    activeData.sourceAmpId === ampId &&
    activeData.sourceChannelIndex === channelIndex;

  return {
    ref: setNodeRef,
    isOver: isOver && !isSameSource,
    isValidTarget: isLocked && !isSameSource, // Valid target only if amp is locked
  };
}

// =============================================================================
// Drag Overlay Component
// =============================================================================

function DragOverlayContent({ data }: { data: DraggableEnclosureData }) {
  const imageUrl = getEnclosureImage(data.enclosureName, 1);

  return (
    <div className="pointer-events-none flex items-center gap-2 rounded-lg border-2 border-blue-500 bg-white px-3 py-2 shadow-xl dark:bg-neutral-800">
      {imageUrl && (
        <img
          src={imageUrl}
          alt={data.enclosureName}
          className="h-10 w-16 object-contain"
        />
      )}
      <div>
        <div className="text-sm font-medium text-gray-900 dark:text-white">
          {data.enclosureName}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Moving 1 unit
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Confirmation Dialog Component
// =============================================================================

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  warningMessage?: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

function ConfirmationDialog({
  isOpen,
  title,
  message,
  warningMessage,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {title}
        </h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {message}
        </p>
        {warningMessage && (
          <div className="mt-3 flex items-start gap-2 rounded bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            <svg className="h-5 w-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span>{warningMessage}</span>
          </div>
        )}
        <label className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="rounded border-gray-300 dark:border-neutral-600"
          />
          Don't ask again
        </label>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-neutral-700"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(dontAskAgain)}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Move Enclosure
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main Provider Component
// =============================================================================

interface EnclosureDragDropProviderProps {
  children: React.ReactNode;
  onMoveEnclosure: (result: EnclosureMoveResult) => void;
  validateDrop?: (
    source: DraggableEnclosureData,
    target: DroppableChannelData
  ) => DropValidation;
}

// Local storage key for "don't ask again" preference
const DONT_ASK_AGAIN_KEY = "enclosure-drag-dont-ask";

export function EnclosureDragDropProvider({
  children,
  onMoveEnclosure,
  validateDrop,
}: EnclosureDragDropProviderProps) {
  const [activeData, setActiveData] = useState<DraggableEnclosureData | null>(null);
  const [overData, setOverData] = useState<DroppableChannelData | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    source: DraggableEnclosureData;
    target: DroppableChannelData;
    validation: DropValidation;
  } | null>(null);

  // Check if user has opted out of confirmations
  const shouldSkipConfirmation = useCallback(() => {
    try {
      return localStorage.getItem(DONT_ASK_AGAIN_KEY) === "true";
    } catch {
      return false;
    }
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DraggableEnclosureData | undefined;
    if (data?.type === "enclosure") {
      setActiveData(data);
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const data = event.over?.data.current as DroppableChannelData | undefined;
    if (data?.type === "channel") {
      setOverData(data);
    } else {
      setOverData(null);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const sourceData = event.active.data.current as DraggableEnclosureData | undefined;
    const targetData = event.over?.data.current as DroppableChannelData | undefined;

    setActiveData(null);
    setOverData(null);

    // Validate the drop
    if (!sourceData || !targetData) return;
    if (sourceData.type !== "enclosure" || targetData.type !== "channel") return;

    // Don't allow dropping on the same channel
    if (
      sourceData.sourceAmpId === targetData.ampId &&
      sourceData.sourceChannelIndex === targetData.channelIndex
    ) {
      return;
    }

    // Validate the drop
    const validation = validateDrop?.(sourceData, targetData) ?? {
      isValid: true,
      requiresConfirmation: false,
    };

    if (!validation.isValid) {
      // Could show an error toast here
      console.warn("Invalid drop:", validation.errorMessage);
      return;
    }

    // Check if confirmation is needed
    if (validation.requiresConfirmation && !shouldSkipConfirmation()) {
      setPendingMove({ source: sourceData, target: targetData, validation });
      return;
    }

    // Execute the move
    onMoveEnclosure({
      enclosureName: sourceData.enclosureName,
      sourceAmpId: sourceData.sourceAmpId,
      sourceChannelIndex: sourceData.sourceChannelIndex,
      targetAmpId: targetData.ampId,
      targetChannelIndex: targetData.channelIndex,
    });
  }, [validateDrop, shouldSkipConfirmation, onMoveEnclosure]);

  const handleConfirm = useCallback((dontAskAgain: boolean) => {
    if (!pendingMove) return;

    if (dontAskAgain) {
      try {
        localStorage.setItem(DONT_ASK_AGAIN_KEY, "true");
      } catch {
        // localStorage not available
      }
    }

    onMoveEnclosure({
      enclosureName: pendingMove.source.enclosureName,
      sourceAmpId: pendingMove.source.sourceAmpId,
      sourceChannelIndex: pendingMove.source.sourceChannelIndex,
      targetAmpId: pendingMove.target.ampId,
      targetChannelIndex: pendingMove.target.channelIndex,
    });

    setPendingMove(null);
  }, [pendingMove, onMoveEnclosure]);

  const handleCancel = useCallback(() => {
    setPendingMove(null);
  }, []);

  const contextValue: EnclosureDragContextValue = {
    isDragging: activeData !== null,
    activeData,
    overData,
  };

  return (
    <EnclosureDragContext.Provider value={contextValue}>
      <DndContext
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        collisionDetection={pointerWithin}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeData && <DragOverlayContent data={activeData} />}
        </DragOverlay>
      </DndContext>
      <ConfirmationDialog
        isOpen={pendingMove !== null}
        title="Move Enclosure"
        message={`Move ${pendingMove?.source.enclosureName} to ${pendingMove?.target.ampModel} Channel ${(pendingMove?.target.channelIndex ?? 0) + 1}?`}
        warningMessage={pendingMove?.validation.warningMessage}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </EnclosureDragContext.Provider>
  );
}
