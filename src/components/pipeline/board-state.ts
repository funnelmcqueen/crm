// Pure client state for the pipeline board: optimistic moves with rollback, per-column paging, and
// the decision of what a drop or a "Move to…" pick does. No React here, so it is unit-tested directly.
import {
  CLOSED_PIPELINE_COLUMNS,
  PIPELINE_COLUMNS,
  type LeadStatus,
  type PipelineColumn,
  type PipelineColumnKey,
} from "@/lib/domain/statuses";
import type { PipelineCard, PipelineColumnPage } from "@/server/services/pipeline";

export const ALL_PIPELINE_COLUMNS: readonly PipelineColumn[] = [...PIPELINE_COLUMNS, ...CLOSED_PIPELINE_COLUMNS];

export function visiblePipelineColumns(closed: boolean): readonly PipelineColumn[] {
  return closed ? ALL_PIPELINE_COLUMNS : PIPELINE_COLUMNS;
}

export function pipelineColumnByKey(key: unknown): PipelineColumn | null {
  return ALL_PIPELINE_COLUMNS.find((column) => column.key === key) ?? null;
}

export interface ColumnState {
  key: PipelineColumnKey;
  cards: PipelineCard[];
  /** Server total for the column, adjusted locally by optimistic moves. */
  total: number;
}

export interface PendingMove {
  leadId: string;
  from: PipelineColumnKey;
  fromIndex: number;
  to: PipelineColumnKey;
  previous: PipelineCard;
}

export interface BoardState {
  /** Visible columns in display order. */
  order: PipelineColumnKey[];
  columns: Partial<Record<PipelineColumnKey, ColumnState>>;
  pending: Record<string, PendingMove>;
}

export type BoardAction =
  | { type: "move"; leadId: string; to: PipelineColumnKey; now: string }
  | { type: "moveSucceeded"; leadId: string; status: LeadStatus }
  | { type: "moveFailed"; leadId: string }
  | { type: "pageLoaded"; page: PipelineColumnPage };

export function initBoardState(pages: readonly PipelineColumnPage[]): BoardState {
  const columns: BoardState["columns"] = {};
  for (const page of pages) {
    columns[page.key] = { key: page.key, cards: [...page.cards], total: Math.max(page.total, page.cards.length) };
  }
  return { order: pages.map((page) => page.key), columns, pending: {} };
}

function time(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Same order as the pipeline_column RPC: next follow-up asc (nulls last), updated desc, id asc. */
export function compareCards(a: PipelineCard, b: PipelineCard): number {
  const fa = time(a.nextFollowUpAt);
  const fb = time(b.nextFollowUpAt);
  if (fa !== fb) {
    if (fa === null) return 1;
    if (fb === null) return -1;
    return fa - fb;
  }
  const ua = time(a.updatedAt) ?? 0;
  const ub = time(b.updatedAt) ?? 0;
  if (ua !== ub) return ub - ua;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function findCard(
  state: BoardState,
  leadId: string,
): { column: PipelineColumnKey; index: number; card: PipelineCard } | null {
  for (const key of state.order) {
    const column = state.columns[key];
    const index = column ? column.cards.findIndex((card) => card.id === leadId) : -1;
    if (column && index >= 0) return { column: key, index, card: column.cards[index] };
  }
  return null;
}

export function hasMoreCards(column: ColumnState): boolean {
  return column.cards.length < column.total;
}

/**
 * Offset for "Load more". Moves are persisted before the next page is fetched, so the cards shown are
 * the server's first N rows (give or take a card moved in, which pageLoaded de-duplicates).
 */
export function nextOffset(column: ColumnState): number {
  return column.cards.length;
}

function withoutCard(column: ColumnState, leadId: string): ColumnState {
  const cards = column.cards.filter((card) => card.id !== leadId);
  if (cards.length === column.cards.length) return column;
  return { ...column, cards, total: Math.max(0, column.total - 1) };
}

function withCardSorted(column: ColumnState, card: PipelineCard): ColumnState {
  if (column.cards.some((existing) => existing.id === card.id)) return column;
  const cards = [...column.cards];
  const index = cards.findIndex((existing) => compareCards(card, existing) < 0);
  cards.splice(index < 0 ? cards.length : index, 0, card);
  return { ...column, cards, total: column.total + 1 };
}

function withCardAt(column: ColumnState, card: PipelineCard, index: number): ColumnState {
  if (column.cards.some((existing) => existing.id === card.id)) return column;
  const cards = [...column.cards];
  cards.splice(Math.min(Math.max(index, 0), cards.length), 0, card);
  return { ...column, cards, total: column.total + 1 };
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case "move": {
      if (state.pending[action.leadId]) return state;
      const found = findCard(state, action.leadId);
      const target = pipelineColumnByKey(action.to);
      if (!found || !target || target.statuses.includes(found.card.status)) return state;

      const columns = { ...state.columns };
      columns[found.column] = withoutCard(columns[found.column]!, action.leadId);
      const moved: PipelineCard = { ...found.card, status: target.dropStatus, updatedAt: action.now };
      // A hidden target (closed columns off) simply takes the card off the board.
      const targetColumn = columns[target.key];
      if (targetColumn) columns[target.key] = withCardSorted(targetColumn, moved);

      return {
        ...state,
        columns,
        pending: {
          ...state.pending,
          [action.leadId]: {
            leadId: action.leadId,
            from: found.column,
            fromIndex: found.index,
            to: target.key,
            previous: found.card,
          },
        },
      };
    }

    case "moveSucceeded": {
      const move = state.pending[action.leadId];
      if (!move) return state;
      const pending = { ...state.pending };
      delete pending[action.leadId];
      const columns = { ...state.columns };
      const column = columns[move.to];
      if (column) {
        columns[move.to] = {
          ...column,
          cards: column.cards.map((card) => (card.id === action.leadId ? { ...card, status: action.status } : card)),
        };
      }
      return { ...state, columns, pending };
    }

    case "moveFailed": {
      const move = state.pending[action.leadId];
      if (!move) return state;
      const pending = { ...state.pending };
      delete pending[action.leadId];
      const columns = { ...state.columns };
      const target = columns[move.to];
      if (target) columns[move.to] = withoutCard(target, action.leadId);
      const source = columns[move.from];
      if (source) columns[move.from] = withCardAt(source, move.previous, move.fromIndex);
      return { ...state, columns, pending };
    }

    case "pageLoaded": {
      const column = state.columns[action.page.key];
      if (!column) return state;
      const onBoard = new Set<string>(Object.keys(state.pending));
      for (const key of state.order) for (const card of state.columns[key]?.cards ?? []) onBoard.add(card.id);
      const fresh = action.page.cards.filter((card) => !onBoard.has(card.id));
      const cards = [...column.cards, ...fresh];
      return {
        ...state,
        columns: { ...state.columns, [column.key]: { ...column, cards, total: Math.max(action.page.total, cards.length) } },
      };
    }
  }
}

export type MoveDecision =
  | { kind: "noop" }
  /** DEVIATIONS D12: only an admin re-opens a Do Not Contact lead. */
  | { kind: "locked" }
  /** Agents confirm Do Not Contact first, like the status select on the lead page. */
  | { kind: "confirm"; to: PipelineColumn }
  | { kind: "move"; to: PipelineColumn };

/**
 * What moving a card with `status` to column `to` does. A card already in the target column is a
 * no-op, so a No Answer card dropped on To Call keeps its No Answer status (DEVIATIONS: pipeline).
 */
export function decideMove(status: LeadStatus, to: unknown, options: { isAdmin: boolean }): MoveDecision {
  const target = pipelineColumnByKey(to);
  if (!target || target.statuses.includes(status)) return { kind: "noop" };
  if (!options.isAdmin && status === "DO_NOT_CONTACT") return { kind: "locked" };
  if (!options.isAdmin && target.dropStatus === "DO_NOT_CONTACT") return { kind: "confirm", to: target };
  return { kind: "move", to: target };
}

/** A drop counts only on a visible column; dropping outside the board or on a hidden column does nothing. */
export function resolveDrop(
  status: LeadStatus | null | undefined,
  overId: string | number | null | undefined,
  visible: readonly PipelineColumnKey[],
  options: { isAdmin: boolean },
): MoveDecision {
  if (!status || overId === null || overId === undefined) return { kind: "noop" };
  if (!visible.some((key) => key === overId)) return { kind: "noop" };
  return decideMove(status, overId, options);
}

/** "Move to…" menu entries: every other column, open ones first. Empty when the card is locked. */
export function moveTargets(status: LeadStatus, options: { isAdmin: boolean }): { open: PipelineColumn[]; closed: PipelineColumn[] } {
  if (!options.isAdmin && status === "DO_NOT_CONTACT") return { open: [], closed: [] };
  const others = ALL_PIPELINE_COLUMNS.filter((column) => !column.statuses.includes(status));
  return { open: others.filter((column) => !column.closed), closed: others.filter((column) => column.closed) };
}
