"use client";

import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, requestEmailChangeAction, updateOwnNameAction } from "@/server/actions/settings";

const INPUT_CLASS = "h-12 text-base md:text-sm";
const MIN_PASSWORD = 10;

function Message({ tone, children }: { tone: "error" | "info"; children: string | null }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={tone === "error" ? "min-h-5 text-sm font-semibold text-destructive" : "min-h-5 text-sm text-muted-foreground"}
    >
      {children ?? ""}
    </p>
  );
}

export function NameForm({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== name;

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateOwnNameAction(value);
      if (result.ok) {
        setValue(result.data.name);
        toast.success("Name saved");
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor="settings-name">Name</Label>
      <div className="flex gap-2">
        <Input
          id="settings-name"
          required
          maxLength={200}
          autoComplete="name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
        <Button type="submit" className="h-12 px-4 font-bold" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Message tone="error">{error}</Message>
    </form>
  );
}

export type EmailChangeNotice = "confirmed" | "failed" | "invalid" | null;

const NOTICE_TEXT: Record<Exclude<EmailChangeNotice, null>, { tone: "error" | "info"; text: string }> = {
  confirmed: { tone: "info", text: "Your email change is confirmed." },
  failed: { tone: "error", text: "That confirmation link didn't work. It may have expired; request the change again." },
  invalid: { tone: "error", text: "That confirmation link is incomplete. Request the change again." },
};

export function EmailForm({ email, notice }: { email: string; notice: EmailChangeNotice }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice ? NOTICE_TEXT[notice].text : null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    const requested = value.trim();
    startTransition(async () => {
      const result = await requestEmailChangeAction(requested);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setValue("");
      if (result.data.pending) {
        setInfo(`Check both inboxes: confirm the change from the links sent to ${email} and ${requested}. Until then you sign in with ${email}.`);
      } else {
        setInfo(`Your email is now ${result.data.email}. Use it the next time you sign in.`);
        toast.success("Email changed");
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor="settings-email">Email</Label>
      <p className="text-sm">
        <span className="text-muted-foreground">Current:</span> <span className="font-semibold break-all">{email}</span>
      </p>
      <div className="flex gap-2">
        <Input
          id="settings-email"
          type="email"
          inputMode="email"
          required
          autoComplete="email"
          placeholder="New email address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
        <Button type="submit" variant="outline" className="h-12 px-4" disabled={pending || value.trim() === ""}>
          {pending ? "Sending…" : "Change"}
        </Button>
      </div>
      {error ? (
        <Message tone="error">{error}</Message>
      ) : (
        <Message tone={notice && info === NOTICE_TEXT[notice].text ? NOTICE_TEXT[notice].tone : "info"}>{info}</Message>
      )}
    </form>
  );
}

export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await changePasswordAction({ currentPassword: current, newPassword: next });
      if (result.ok) {
        setCurrent("");
        setNext("");
        setConfirm("");
        toast.success("Password changed");
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm font-medium">Password</p>
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-current-password" className="text-xs text-muted-foreground">
          Current password
        </Label>
        <Input
          id="settings-current-password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-new-password" className="text-xs text-muted-foreground">
            New password <span className="font-normal">(10+ characters)</span>
          </Label>
          <Input
            id="settings-new-password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            maxLength={72}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-confirm-password" className="text-xs text-muted-foreground">
            Confirm new password
          </Label>
          <Input
            id="settings-confirm-password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            maxLength={72}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <Message tone="error">{error}</Message>
      <div>
        <Button type="submit" variant="outline" className="h-12 px-4" disabled={pending}>
          {pending ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
