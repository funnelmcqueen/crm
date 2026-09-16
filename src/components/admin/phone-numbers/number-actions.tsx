"use client";

import { EllipsisVertical, Power, PowerOff, Undo2, UserRoundPlus } from "lucide-react";
import { useState, useTransition } from "react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import {
  assignPhoneNumberAction,
  deactivatePhoneNumberAction,
  reactivatePhoneNumberAction,
  unassignPhoneNumberAction,
} from "@/server/actions/phone-numbers";
import type { ActionResult } from "@/server/errors";
import type { AssignableAgent, PhoneNumberListRow } from "@/server/services/phone-numbers";

export interface NumberActionsProps {
  number: Pick<PhoneNumberListRow, "id" | "e164" | "active" | "assignedTo" | "assignedName">;
  /** Active agents and admins. */
  agents: AssignableAgent[];
  className?: string;
}

export function NumberActions({ number, agents, className }: NumberActionsProps) {
  const display = formatPhoneDisplay(number.e164);
  const [assignOpen, setAssignOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<ActionResult<unknown>>, success: string, onDone?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        onDone?.();
      } else {
        toast.error(result.error.message);
      }
    });
  }

  function openAssign() {
    setTarget(number.assignedTo && agents.some((a) => a.id === number.assignedTo) ? number.assignedTo : "");
    setAssignOpen(true);
  }

  const targetName = agents.find((a) => a.id === target)?.name;

  return (
    <>
      {/* Non-modal so the dialogs opened from it keep focus and pointer events. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn("h-12 gap-2 px-3", className)}
            disabled={pending}
            aria-label={`Actions for ${display}`}
          >
            <EllipsisVertical aria-hidden />
            <span>{pending ? "Saving…" : "Actions"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem className="min-h-12 gap-2" onSelect={openAssign}>
            <UserRoundPlus aria-hidden />
            {number.assignedTo ? "Reassign to agent…" : "Assign to agent…"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-12 gap-2"
            disabled={!number.assignedTo}
            onSelect={() => run(() => unassignPhoneNumberAction(number.id), `${display} is back in the pool`)}
          >
            <Undo2 aria-hidden />
            Unassign (back to pool)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {number.active ? (
            <DropdownMenuItem
              className="min-h-12 gap-2 text-destructive focus:text-destructive"
              onSelect={() => setDeactivateOpen(true)}
            >
              <PowerOff aria-hidden className="text-destructive" />
              Deactivate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className="min-h-12 gap-2"
              onSelect={() => run(() => reactivatePhoneNumberAction(number.id), `${display} is active again`)}
            >
              <Power aria-hidden />
              Reactivate
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign {display}</DialogTitle>
            <DialogDescription>
              The agent calls out from this number, and unknown callers to it ring that agent.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`assign-${number.id}`}>Agent</Label>
            <Select value={target} onValueChange={setTarget} disabled={pending}>
              <SelectTrigger id={`assign-${number.id}`} className="w-full px-3 data-[size=default]:h-12">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent position="popper" align="start" className="max-h-80">
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="min-h-12">
                    {agent.name}
                    {agent.role === "ADMIN" ? <span className="text-muted-foreground"> · Admin</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">There are no active agents to assign.</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-12" onClick={() => setAssignOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              className="h-12 font-bold"
              disabled={pending || target === "" || target === number.assignedTo}
              onClick={() =>
                run(
                  () => assignPhoneNumberAction(number.id, target),
                  `${display} assigned to ${targetName ?? "the agent"}`,
                  () => setAssignOpen(false),
                )
              }
            >
              {pending ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deactivateOpen} onOpenChange={setDeactivateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {display}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops being used as a caller ID, and unknown callers to it go to admin voicemail. Leads calling back
              still reach their agent. The number stays in your Twilio account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-12 font-bold"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                run(() => deactivatePhoneNumberAction(number.id), `${display} deactivated`, () => setDeactivateOpen(false));
              }}
            >
              {pending ? "Deactivating…" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
