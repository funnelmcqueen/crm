export type CallPlaybookStageId = "open" | "hook" | "offer" | "ask" | "booked";
export type CallPlaybookObjectionId = "price" | "low-delivery" | "discovery" | "website" | "busy" | "location" | "email" | "decline";

export interface CallPlaybookStage {
  id: CallPlaybookStageId;
  title: string;
  line: string;
  coaching: string;
}

export interface CallPlaybookObjection {
  id: CallPlaybookObjectionId;
  prompt: string;
  response: string;
}

export interface CallPlaybook {
  id: string;
  version: string;
  title: string;
  audience: string;
  goal: string;
  stages: readonly CallPlaybookStage[];
  objections: readonly CallPlaybookObjection[];
  bookingHandoff: string;
  noShowRecovery: string;
  guardrails: readonly string[];
}

const firstName = (contactName: string | null): string | null => {
  const trimmed = contactName?.trim();
  return trimmed ? (trimmed.split(/\s+/)[0] ?? null) : null;
};

export function playbookGreeting(contactName: string | null, agentName: string | null): string {
  const name = firstName(contactName) ?? "there";
  const agent = firstName(agentName);
  return agent
    ? `Hey ${name} — ${agent}. We spoke in March and you asked me to call you back around now. Is now still a good time?`
    : `Hey ${name}. We spoke in March and you asked me to call you back around now. Is now still a good time?`;
}

export const MARCH_RESTAURANT_PLAYBOOK: CallPlaybook = {
  id: "march-restaurants-paid",
  version: "v3",
  title: "March restaurant callback",
  audience: "Independent local restaurants who asked for a callback in March.",
  goal: "Book a 15-minute fit call. Nothing else.",
  stages: [
    {
      id: "open",
      title: "Open",
      line: "We spoke in March and you asked me to call you back around now. Is now still a good time?",
      coaching: "Pause. If they do not remember, say you spoke about their website and ask whether timing is any better. Do not recap the old call.",
    },
    {
      id: "hook",
      title: "Hook",
      line: "Are you using DoorDash or another ordering platform today? Roughly what do they keep from an order once fees and promotions are included?",
      coaching: "Let them answer. The point is to see whether repeat customers should have a direct way to order.",
    },
    {
      id: "offer",
      title: "Offer",
      line: "I build custom restaurant sites with direct online ordering, plus catering or reservation pages when they make sense. It is a paid build, but the goal is to give regulars a direct route back to you.",
      coaching: "Say “paid build” early. Do not promise a timeline or outcome before the scope is confirmed.",
    },
    {
      id: "ask",
      title: "Ask",
      line: "Worth 15 minutes to see whether that would make sense for your restaurant? Is Tuesday at 10 better, or Wednesday at 2?",
      coaching: "Pause for two seconds. If they hesitate, offer the two times once more, then stop.",
    },
    {
      id: "booked",
      title: "After booking",
      line: "Are you on any other delivery apps too? Will anyone else be involved in deciding on this?",
      coaching: "Ask only these two questions after a time is agreed. Everything else belongs in the 15-minute fit call.",
    },
  ],
  objections: [
    {
      id: "price",
      prompt: "How much is it?",
      response: "Most builds are $2,000. The 15 minutes tells us whether direct ordering or a catering page is the better fit and what the scope would be. Tuesday at 10 or Wednesday at 2?",
    },
    {
      id: "low-delivery",
      prompt: "I do not do much delivery.",
      response: "Fair. Then I would look at reservations, private events, and catering. Do you have a page built for that today? Worth 15 minutes to take a look?",
    },
    {
      id: "discovery",
      prompt: "DoorDash brings me new customers.",
      response: "It can. Keep it for discovery. I am talking about repeat customers who already know you—giving them a direct route so every repeat order is not charged a platform fee.",
    },
    {
      id: "website",
      prompt: "I already have a website.",
      response: "Good. We can compare it with what direct ordering and a proper catering page could add. If your current site already does that well, I will tell you.",
    },
    {
      id: "busy",
      prompt: "I am slammed.",
      response: "I know. That is why I am asking for 15 minutes, not an hour. Is Tuesday at 10, before service, better—or Wednesday at 2?",
    },
    {
      id: "location",
      prompt: "You are in Albania.",
      response: "I am. The company is registered in the US. You get a written scope and invoice; it is half to start and the balance only when the site is live.",
    },
    {
      id: "email",
      prompt: "Just email me.",
      response: "I can send a short summary. The useful part is seeing whether delivery, catering, or reservations is the bigger opportunity for you. Can we reserve 15 minutes first—Tuesday at 10 or Wednesday at 2?",
    },
    {
      id: "decline",
      prompt: "Not interested.",
      response: "Understood. Is that mainly timing, or is this simply not a priority for the restaurant? If it is not a priority, thank them and close the call.",
    },
  ],
  bookingHandoff: "Send a calendar invite immediately with their local time, meeting link or phone number, and a one-line agenda. Two hours before the call, send: “We are set for 10:00 AM today for 15 minutes. Still good? Reply YES and I will call you then.”",
  noShowRecovery: "Call three minutes after the scheduled start. Ten minutes later, offer two new times by text. Try once more on the next business day, then return the lead to the callback queue with a dated note.",
  guardrails: [
    "The only job on this call is booking the 15 minutes.",
    "Answer the price question directly; do not dodge it twice.",
    "Make only claims that are accurate for the business.",
    "Stop after a clear decline or a request not to be contacted.",
    "Call restaurants in their local quiet window, never during lunch or dinner service.",
  ],
};
