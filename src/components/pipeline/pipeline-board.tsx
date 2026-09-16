"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { PipelineColumn, PipelineColumnKey } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";
import { loadPipelineColumnAction, moveLeadToColumnAction } from "@/server/actions/pipeline";
import type { PipelineCard, PipelineColumnPage } from "@/server/services/pipeline";
import {
  boardReducer,
  decideMove,
  findCard,
  initBoardState,
  nextOffset,
  pipelineColumnByKey,
  resolveDrop,
  type BoardAction,
  type BoardState,
  type MoveDecision,
} from "./board-state";
import { DraggablePipelineCard, PipelineCardView } from "./pipeline-card";
import { PipelineColumnView } from "./pipeline-column";
import { MousePointerSensor, columnKeyboardCoordinates } from "./sensors";

export interface PipelineBoardProps {
  initialColumns: PipelineColumnPage[];
  isAdmin: boolean;
  /** Admin filters, sent again with "Load more". */
  agentId: string | null;
  unassigned: boolean;
  tz: string;
  now: number;
  /** Admin without an agent filter: agent id -> name, to label each card. Null hides the label. */
  agentNames: Record<string, string> | null;
}

// Pointer collisions for mouse and touch; rect overlap for keyboard drags, which have no pointer.
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

const MOVE_FAILED = "Couldn't move the lead. Try again.";

export function PipelineBoard({ initialColumns, isAdmin, agentId, unassigned, tz, now, agentNames }: PipelineBoardProps) {
  const [state, setState] = useState<BoardState>(() => initBoardState(initialColumns));
  // A new server render (filter change, navigation) replaces the board state.
  const [syncedColumns, setSyncedColumns] = useState(initialColumns);
  if (initialColumns !== syncedColumns) {
    setSyncedColumns(initialColumns);
    setState(initBoardState(initialColumns));
  }

  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingColumns, setLoadingColumns] = useState<Partial<Record<PipelineColumnKey, boolean>>>({});
  const [confirm, setConfirm] = useState<{ card: PipelineCard; to: PipelineColumn } | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  const dispatch = useCallback((action: BoardAction) => setState((current) => boardReducer(current, action)), []);

  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates }),
  );

  const commitMove = useCallback(
    async (card: PipelineCard, to: PipelineColumn) => {
      dispatch({ type: "move", leadId: card.id, to: to.key, now: new Date().toISOString() });
      let result: Awaited<ReturnType<typeof moveLeadToColumnAction>> | null = null;
      try {
        result = await moveLeadToColumnAction(card.id, to.key);
      } catch {
        result = null;
      }
      if (result?.ok) {
        dispatch({ type: "moveSucceeded", leadId: card.id, status: result.data.status });
        setLiveMessage(`${card.businessName} moved to ${to.label}.`);
        if (!state.columns[to.key]) toast.success(`${card.businessName} moved to ${to.label}`);
      } else {
        dispatch({ type: "moveFailed", leadId: card.id });
        toast.error(result ? result.error.message : MOVE_FAILED);
        setLiveMessage(`${card.businessName} was not moved.`);
      }
    },
    [dispatch, state.columns],
  );

  function apply(card: PipelineCard, decision: MoveDecision) {
    if (state.pending[card.id]) return;
    switch (decision.kind) {
      case "noop":
        return;
      case "locked":
        toast.error("Only an admin can reopen a Do Not Contact lead.");
        return;
      case "confirm":
        setConfirm({ card, to: decision.to });
        return;
      case "move":
        void commitMove(card, decision.to);
        return;
    }
  }

  function onMenuMove(card: PipelineCard, to: PipelineColumnKey) {
    const current = findCard(state, card.id)?.card ?? card;
    apply(current, decideMove(current.status, to, { isAdmin }));
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const found = findCard(state, String(event.active.id));
    if (!found) return;
    apply(found.card, resolveDrop(found.card.status, event.over?.id, state.order, { isAdmin }));
  }

  async function loadMore(key: PipelineColumnKey) {
    const column = state.columns[key];
    if (!column || loadingColumns[key]) return;
    setLoadingColumns((current) => ({ ...current, [key]: true }));
    try {
      const result = await loadPipelineColumnAction({ column: key, offset: nextOffset(column), agentId, unassigned });
      if (result.ok) dispatch({ type: "pageLoaded", page: result.data });
      else toast.error(result.error.message);
    } catch {
      toast.error("Couldn't load more leads. Try again.");
    } finally {
      setLoadingColumns((current) => ({ ...current, [key]: false }));
    }
  }

  const nameOf = (id: UniqueIdentifier) => findCard(state, String(id))?.card.businessName ?? "Lead";
  const labelOf = (id: UniqueIdentifier) => pipelineColumnByKey(id)?.label ?? "a column";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} is over ${labelOf(over.id)}.` : `${nameOf(active.id)} is not over a column.`),
    onDragEnd: ({ active, over }) => (over ? `${nameOf(active.id)} dropped on ${labelOf(over.id)}.` : `${nameOf(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  const activeCard = activeId ? (findCard(state, activeId)?.card ?? null) : null;
  const agentLabel = (card: PipelineCard) =>
    agentNames ? (card.assignedTo ? (agentNames[card.assignedTo] ?? "Unknown") : null) : undefined;

  return (
    <>
      <DndContext
        id="pipeline-board"
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "To move a lead, press space or enter on its drag handle, use the left and right arrow keys to pick a column, then press space or enter to drop it. Press escape to cancel. The Move to menu does the same.",
          },
        }}
      >
        <div
          role="region"
          aria-label="Pipeline columns"
          className={cn(
            // relative: the region must be the containing block of the cards' absolutely positioned sr-only text,
            // otherwise that text is laid out against the page and widens it on phones despite overflow-x-auto.
            "relative -mx-4 flex scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0",
            activeId ? "snap-none" : "snap-x snap-mandatory md:snap-none",
          )}
        >
          {state.order.map((key) => {
            const column = pipelineColumnByKey(key);
            const columnState = state.columns[key];
            if (!column || !columnState) return null;
            return (
              <PipelineColumnView
                key={key}
                column={column}
                total={columnState.total}
                shown={columnState.cards.length}
                loading={loadingColumns[key] === true}
                dragging={activeId !== null}
                onLoadMore={() => void loadMore(key)}
              >
                {columnState.cards.map((card) => (
                  <DraggablePipelineCard
                    key={card.id}
                    card={card}
                    tz={tz}
                    now={now}
                    agentName={agentLabel(card)}
                    isAdmin={isAdmin}
                    pending={state.pending[card.id] !== undefined}
                    onMove={onMenuMove}
                  />
                ))}
              </PipelineColumnView>
            );
          })}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <PipelineCardView card={activeCard} tz={tz} now={now} agentName={agentLabel(activeCard)} overlay className="w-72" />
          ) : null}
        </DragOverlay>
      </DndContext>

      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : setConfirm(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Do Not Contact?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? `${confirm.card.businessName} can no longer be called. ` : ""}Only an admin can reopen it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-12"
              onClick={() => {
                if (confirm) void commitMove(confirm.card, confirm.to);
                setConfirm(null);
              }}
            >
              Do Not Contact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
