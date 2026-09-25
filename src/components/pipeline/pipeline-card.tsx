"use client";

import { useDraggable } from "@dnd-kit/core";
import { ArrowRightLeft, CalendarClock, GripVertical, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatNumber } from "@/lib/i18n/format";
import { FollowUpCell } from "@/components/leads/lead-list-cells";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pipelineBadgeFor, type PipelineColumnKey } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";
import type { PipelineCard } from "@/server/services/pipeline";
import { moveTargets } from "./board-state";

export interface PipelineCardViewProps {
  card: PipelineCard;
  tz: string;
  now: number;
  /** Admin board without an agent filter: the assigned agent's name, or null for unassigned. */
  agentName?: string | null;
  /** Right rail (move menu and drag handle). */
  actions?: ReactNode;
  className?: string;
  /** Rendered inside the DragOverlay: no link, lifted look. */
  overlay?: boolean;
}

function CardBody({ card, tz, now, agentName }: Pick<PipelineCardViewProps, "card" | "tz" | "now" | "agentName">) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const statuses = useTranslations("workspace").statuses;
  const badge = pipelineBadgeFor(card.status);
  return (
    <>
      <span className="truncate text-sm leading-tight font-bold">{card.businessName}</span>
      {card.contactName ? <span className="truncate text-xs text-muted-foreground">{card.contactName}</span> : null}
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {badge ? (
          <span
            data-status={card.status}
            className="inline-flex h-5 items-center gap-1 rounded-full border bg-muted/60 px-2 font-semibold whitespace-nowrap"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-gold" />
            {badge ? statuses[card.status] : null}
          </span>
        ) : null}
        <span className="inline-flex min-w-0 items-center gap-1">
          <CalendarClock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">{t.nextFollowUp}</span>
          <FollowUpCell value={card.nextFollowUpAt} tz={tz} now={now} className="truncate" />
        </span>
        <span className="ml-auto text-muted-foreground">
          <span className="font-extrabold text-foreground tabular-nums">{formatNumber(card.callCount, locale)}</span>{" "}
          {card.callCount === 1 ? t.call : t.calls}
        </span>
      </span>
      {agentName !== undefined ? (
        <span className="truncate text-xs text-muted-foreground">
          {t.agent}: <span className="text-foreground">{agentName ?? t.unassigned}</span>
        </span>
      ) : null}
    </>
  );
}

export function PipelineCardView({ card, tz, now, agentName, actions, className, overlay }: PipelineCardViewProps) {
  return (
    <div
      className={cn(
        "flex items-stretch rounded-lg border bg-card",
        overlay && "cursor-grabbing border-primary shadow-md",
        className,
      )}
    >
      {overlay ? (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-3">
          <CardBody card={card} tz={tz} now={now} agentName={agentName} />
        </div>
      ) : (
        <Link
          href={`/leads/${card.id}`}
          draggable={false}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-l-lg p-3 outline-none transition-colors duration-100 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-touch-callout:none]"
        >
          <CardBody card={card} tz={tz} now={now} agentName={agentName} />
        </Link>
      )}
      {actions ? <div className="flex shrink-0 flex-col border-l">{actions}</div> : null}
    </div>
  );
}

export interface DraggablePipelineCardProps {
  card: PipelineCard;
  tz: string;
  now: number;
  agentName?: string | null;
  isAdmin: boolean;
  /** A move for this card is waiting for the server. */
  pending: boolean;
  onMove(card: PipelineCard, to: PipelineColumnKey): void;
}

// Keeps a press on the menu button from also arming a drag on the card around it.
const stopDragStart = {
  onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
  onTouchStart: (event: { stopPropagation(): void }) => event.stopPropagation(),
};

export function DraggablePipelineCard({ card, tz, now, agentName, isAdmin, pending, onMove }: DraggablePipelineCardProps) {
  const t = useTranslations("operations");
  const stages = useTranslations("workspace").statuses;
  const targets = moveTargets(card.status, { isAdmin });
  const locked = targets.open.length === 0 && targets.closed.length === 0;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id,
    data: { status: card.status },
    disabled: locked || pending,
  });

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      data-lead-id={card.id}
      aria-busy={pending || undefined}
      className={cn("touch-manipulation select-none", isDragging && "opacity-40", pending && "opacity-70")}
    >
      <PipelineCardView
        card={card}
        tz={tz}
        now={now}
        agentName={agentName}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild {...stopDragStart}>
                <Button
                  variant="ghost"
                  className="size-12 rounded-none rounded-tr-lg"
                  aria-label={t.moveToAria.replace("{name}", card.businessName)}
                  disabled={pending}
                >
                  {locked ? <Lock aria-hidden className="size-4" /> : <ArrowRightLeft aria-hidden className="size-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {locked ? (
                  <DropdownMenuLabel className="px-2 py-3 text-sm font-normal text-muted-foreground">
                    {t.locked}
                  </DropdownMenuLabel>
                ) : (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t.moveTo}</DropdownMenuLabel>
                    {targets.open.map((column) => (
                      <DropdownMenuItem key={column.key} className="min-h-12 px-3" onSelect={() => onMove(card, column.key)}>
                        {stages[column.key]}
                      </DropdownMenuItem>
                    ))}
                    {targets.closed.length > 0 ? <DropdownMenuSeparator /> : null}
                    {targets.closed.map((column) => (
                      <DropdownMenuItem
                        key={column.key}
                        className="min-h-12 px-3"
                        variant={column.dropStatus === "DO_NOT_CONTACT" ? "destructive" : "default"}
                        onSelect={() => onMove(card, column.key)}
                      >
                        {stages[column.key]}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              aria-label={t.dragAria.replace("{name}", card.businessName)}
              aria-disabled={locked || pending || undefined}
              className={cn(
                "flex min-h-12 w-12 flex-1 items-center justify-center rounded-br-lg text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                locked || pending ? "cursor-not-allowed opacity-50" : "cursor-grab",
              )}
            >
              <GripVertical aria-hidden className="size-4" />
            </button>
          </>
        }
      />
    </li>
  );
}
