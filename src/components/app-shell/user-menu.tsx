"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clearPendingTel } from "@/lib/dialer/drivers/tel";
import { clearWorkspaceDrafts } from "@/lib/dialer/workspace-drafts";
import { confirmUnsavedNotes, releaseUnsavedNotes } from "@/components/common/use-unsaved-notes";
import { LOGIN_PATH } from "@/lib/supabase/auth-redirect";
import { cn } from "@/lib/utils";
import { signOut } from "@/server/actions/auth";
import { roleLabel, type ShellUser } from "./nav-config";

function initials(user: ShellUser): string {
  const source = user.name.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return letters || "?";
}

export function UserMenu({ user, compact = false }: { user: ShellUser; compact?: boolean }) {
  const [signingOut, startSignOut] = useTransition();
  const displayName = user.name.trim() || user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${displayName}`}
          className={cn(
            "flex min-h-12 items-center gap-3 rounded-lg text-left outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
            compact ? "min-w-12 justify-center" : "w-full px-2",
          )}
        >
          <Avatar>
            <AvatarFallback className="text-xs font-bold text-foreground">{initials(user)}</AvatarFallback>
          </Avatar>
          {compact ? null : (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{displayName}</span>
              <span className="block truncate text-xs text-muted-foreground">{roleLabel(user.role)}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "end" : "start"} side={compact ? "bottom" : "top"} className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
          <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-12">
          <Link href="/settings">
            <Settings aria-hidden />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          className="min-h-12"
          onSelect={() => {
            if (!confirmUnsavedNotes(true)) return;
            startSignOut(async () => {
              try {
                await signOut();
              } catch {
                toast.error("Couldn't sign out. Check your connection and try again. Your drafts are still here.");
                return;
              }
              // A tapped phone call is this user's data; the next person on a shared device must not find it.
              clearPendingTel();
              clearWorkspaceDrafts();
              releaseUnsavedNotes();
              // A full page load drops every in-memory client store (dialer, badge counts) of this user.
              window.location.replace(LOGIN_PATH);
            });
          }}
        >
          <LogOut aria-hidden />
          {signingOut ? "Signing out..." : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
