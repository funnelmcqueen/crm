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
    ? `Hi ${name}, it’s ${agent} from FunnelMcQueen. We spoke a few months ago about helping you bring in more customers, but the timing wasn’t right. How have things been?`
    : `Hi ${name}, I’m calling from FunnelMcQueen. We spoke a few months ago about helping you bring in more customers, but the timing wasn’t right. How have things been?`;
}

// Keep the exported name and ID stable for existing consumers.
export const MARCH_RESTAURANT_PLAYBOOK: CallPlaybook = {
  id: "march-restaurants-paid",
  version: "v4",
  title: "Restaurant reconnecting call",
  audience: "Restaurant owners who previously said the timing was not right.",
  goal: "Book a 20-minute video meeting to explore opportunities for more customers.",
  stages: [
    {
      id: "open",
      title: "Reconnect",
      line: "We spoke a few months ago about helping you bring in more customers, but the timing wasn’t right. How have things been?",
      coaching: "Pause and listen. Refer to the earlier conversation only when the lead history supports it. Keep the call to 2-4 minutes; save discovery for the meeting."
    },
    {
      id: "hook",
      title: "Check timing",
      line: "Has anything changed since we last spoke? Is bringing in more customers something you’re looking at right now?",
      coaching: "Listen for changed priorities. If it is still not the right time, ask what would need to change and agree on a callback date if they want one."
    },
    {
      id: "offer",
      title: "Meeting purpose",
      line: "I’d like to learn more about the restaurant and share a couple of ideas that could help bring in more customers.",
      coaching: "Keep the benefit simple: more customers or more bookings. Save website, ads, SEO, your business story and detailed questions for the meeting. Do not guarantee results."
    },
    {
      id: "ask",
      title: "Book the meeting",
      line: "Would you be open to a quick 20-minute Zoom or Google Meet call? Would [day/time A] or [day/time B] work better? No need to have your camera on.",
      coaching: "Offer two real available times outside service hours and confirm the client’s timezone. Prefer video for screen sharing; accept a phone meeting if they prefer."
    },
    {
      id: "booked",
      title: "Confirm email and time",
      line: "What’s the best email to send you the calendar invite? Just to confirm, that’s [day] at [time] your time, [timezone] - correct?",
      coaching: "Send the invite while still on the call if possible, then say: “I’ve just sent it over - could you check that it came through?” Check whether anyone else should join. Do not say it was sent until it actually was."
    }
  ],
  objections: [
    {
      id: "price",
      prompt: "How much is it?",
      response: "It depends on what you need. The meeting helps us understand that so I can give you a clear scope and price. If you need a number before meeting, I can share our current pricing once we know the scope."
    },
    {
      id: "low-delivery",
      prompt: "I do not do much delivery.",
      response: "That’s fine. The opportunity might be dine-in guests, reservations, or private events. We can use the meeting to see what matters most to your restaurant."
    },
    {
      id: "discovery",
      prompt: "DoorDash brings me new customers.",
      response: "Good to hear. I’d like to understand what is already working and whether there are other opportunities to bring in more customers."
    },
    {
      id: "website",
      prompt: "I already have a website.",
      response: "That’s helpful. We can look at how your current online presence supports your goals and whether anything could work better. We don’t need to assume you need a new website."
    },
    {
      id: "busy",
      prompt: "I am slammed.",
      response: "Of course. When would be a quieter time to reconnect? We can arrange the meeting outside service hours."
    },
    {
      id: "location",
      prompt: "You are in Albania.",
      response: "Yes, I’m based in Albania. We can meet online, and any proposal will clearly set out the scope, timing and payment terms."
    },
    {
      id: "email",
      prompt: "Just email me.",
      response: "Of course. What’s the best email address? I’ll send a brief summary, and you can let me know if a conversation would be useful."
    },
    {
      id: "decline",
      prompt: "Not now / not interested.",
      response: "If timing is the issue: “What would need to change for this to become a priority?” If they clearly decline, thank them and end the call. Do not keep pushing for a meeting."
    }
  ],
  bookingHandoff: "Manually send a calendar invite by email using Google Calendar or Outlook with a Meet/Zoom link, agreed time and timezone, and 20-minute duration. Title: FunnelMcQueen × [Restaurant Name]. Agenda: Discuss your restaurant’s goals and opportunities to bring in more customers. Confirm receipt; email a short reminder before the meeting.",
  noShowRecovery: "Call once shortly after the scheduled start. If they do not answer, email a brief rescheduling message with two available times. Record the outcome and a dated next step in the CRM.",
  guardrails: [
    "This call is for reconnecting and booking the meeting; detailed discovery belongs in the second meeting.",
    "Use real availability and confirm the client’s local date, time and timezone.",
    "Make only verified claims. Do not invent prior conversations, prices, results, registration details or payment terms.",
    "Stop after a clear decline or a request not to be contacted.",
    "Call outside lunch and dinner service. Log the outcome and the next step with a date."
  ]
};
