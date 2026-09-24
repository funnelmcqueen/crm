import { BookOpenCheck } from "lucide-react";
import { MARCH_RESTAURANT_PLAYBOOK } from "@/lib/domain/call-playbook";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";

export interface CallPlaybookProps {
  contactName: string | null;
  agentName: string | null;
}

export function CallPlaybook({ contactName, agentName }: CallPlaybookProps) {
  const playbook = MARCH_RESTAURANT_PLAYBOOK;
  const { locale } = useLocale();
  const t = useTranslations("workspace");
  const p = t.playbookContent;
  const first = (name: string | null) => name?.trim().split(/\s+/)[0] || null;
  const name = first(contactName) ?? (locale === "de" ? "zusammen" : "there");
  const agent = first(agentName);
  const greeting = (agent ? p.greetingWithAgent.replace("{agent}", agent) : p.greeting).replace("{name}", name);
  const stages = [
    { id: "open", title: p.openTitle, line: p.openLine, coaching: p.openCoaching },
    { id: "hook", title: p.hookTitle, line: p.hookLine, coaching: p.hookCoaching },
    { id: "offer", title: p.offerTitle, line: p.offerLine, coaching: p.offerCoaching },
    { id: "ask", title: p.askTitle, line: p.askLine, coaching: p.askCoaching },
    { id: "booked", title: p.bookedTitle, line: p.bookedLine, coaching: p.bookedCoaching },
  ];
  const objections = [
    { id: "price", prompt: p.pricePrompt, response: p.priceResponse },
    { id: "low-delivery", prompt: p.lowDeliveryPrompt, response: p.lowDeliveryResponse },
    { id: "discovery", prompt: p.discoveryPrompt, response: p.discoveryResponse },
    { id: "website", prompt: p.websitePrompt, response: p.websiteResponse },
    { id: "busy", prompt: p.busyPrompt, response: p.busyResponse },
    { id: "location", prompt: p.locationPrompt, response: p.locationResponse },
    { id: "email", prompt: p.emailPrompt, response: p.emailResponse },
    { id: "decline", prompt: p.declinePrompt, response: p.declineResponse },
  ];
  const guardrails = [p.rule1, p.rule2, p.rule3, p.rule4, p.rule5];

  return (
    <section aria-label={t.playbookUi.aria} className="mb-4 rounded-xl border border-primary/25 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BookOpenCheck aria-hidden className="size-4 text-primary" />
            <h2 className="text-sm font-extrabold">{p.title}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{p.goal}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">{playbook.version}</span>
      </div>

      <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p className="text-xs font-bold tracking-wide text-primary uppercase">{t.playbookUi.nextLine}</p>
        <p className="mt-1 text-sm font-semibold leading-6">“{greeting}”</p>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {stages.map((stage) => (
          <details key={stage.id} className="rounded-lg border bg-background px-3">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-bold marker:hidden focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50">
              <span>{stage.title}</span>
              <span aria-hidden className="text-muted-foreground">+</span>
            </summary>
            <div className="border-t pb-3 pt-2">
              <p className="text-sm leading-6">“{stage.id === "open" ? greeting : stage.line}”</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{stage.coaching}</p>
            </div>
          </details>
        ))}
      </div>

      <details className="mt-3 rounded-lg border bg-background px-3">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-bold marker:hidden focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50">
          <span>{t.playbookUi.objections}</span>
          <span aria-hidden className="text-muted-foreground">+</span>
        </summary>
        <div className="grid gap-2 border-t py-3 md:grid-cols-2">
          {objections.map((objection) => (
            <details key={objection.id} className="rounded-md border px-3">
              <summary className="flex min-h-12 cursor-pointer list-none items-center py-2 text-sm font-semibold marker:hidden focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50">
                “{objection.prompt}”
              </summary>
              <p className="border-t pb-3 pt-2 text-sm leading-6">“{objection.response}”</p>
            </details>
          ))}
        </div>
      </details>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-muted p-3">
          <h3 className="text-xs font-bold tracking-wide uppercase">{t.playbookUi.bookingHandoff}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{p.booking}</p>
        </div>
        <div className="rounded-lg bg-muted p-3">
          <h3 className="text-xs font-bold tracking-wide uppercase">{t.playbookUi.noShowRecovery}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{p.noShow}</p>
        </div>
      </div>

      <details className="mt-3 rounded-lg px-1">
        <summary className="flex min-h-12 cursor-pointer list-none items-center text-xs font-semibold text-muted-foreground marker:hidden focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50">
          {t.playbookUi.guardrails}
        </summary>
        <ul className="list-disc space-y-1 pb-2 pl-5 text-xs leading-5 text-muted-foreground">
          {guardrails.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </details>
    </section>
  );
}
