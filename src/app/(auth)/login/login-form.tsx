"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/server/actions/auth";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signIn, null);
  const failed = state !== null;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state?.email}
          aria-invalid={failed || undefined}
          aria-describedby={failed ? "login-error" : undefined}
          className="h-12 px-3 text-base"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={failed || undefined}
          aria-describedby={failed ? "login-error" : undefined}
          className="h-12 px-3 text-base"
        />
      </div>

      <div aria-live="polite" className="-my-1 min-h-5">
        {failed ? (
          <p id="login-error" className="text-sm font-semibold text-destructive">
            {state.error.message}
          </p>
        ) : null}
      </div>

      <Button type="submit" disabled={pending} className="h-12 w-full text-base font-bold">
        {pending ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
