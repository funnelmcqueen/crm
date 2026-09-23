// The pep-talk pool (docs/DEVIATIONS.md D49). One-liners shown to an agent between calls.
//
// House rules for anything added here, because they are what keep this funny instead of grim:
//   - The joke lands on the situation, the prospect's excuses, the job, or the universe. Never on the
//     agent. Someone who just got hung up on is the audience, not the punchline.
//   - Nothing about anyone's identity, and no line that reads as an instruction to be rude to a
//     prospect. Gallows humour about the work, not advice.
//   - `clean` carries no profanity at all, `salty` is mild, `raw` is the sales floor. A viewer sees
//     their chosen level and everything gentler, so every bucket needs at least one `clean` line or
//     an agent on the mildest setting sees nothing.
//   - `{business}` is replaced with the lead's name and `{dials}` with the day's call count. A line
//     using a placeholder is skipped when that value is missing, so it never renders a raw brace.
import type { PepBucket, PepLevel } from "./pep-talk";

export interface PepLine {
  id: string;
  bucket: PepBucket;
  level: PepLevel;
  text: string;
}

export const PEP_LINES: readonly PepLine[] = [
  // --- No answer ------------------------------------------------------------------------------
  { id: "na-1", bucket: "outcome:NO_ANSWER", level: "clean", text: "They're alive. They're just choosing this." },
  { id: "na-2", bucket: "outcome:NO_ANSWER", level: "clean", text: "No answer. That phone is face-down under a pile of unopened mail, with every other decision they've been avoiding." },
  { id: "na-3", bucket: "outcome:NO_ANSWER", level: "clean", text: "Nobody home. The call costs you forty seconds. Ignoring it costs them the quarter." },
  { id: "na-4", bucket: "outcome:NO_ANSWER", level: "salty", text: "No pickup. Cowards, the lot of them." },
  { id: "na-5", bucket: "outcome:NO_ANSWER", level: "salty", text: "{business} let it ring. Somewhere in that building a phone is vibrating itself off a desk and nobody has the spine to touch it." },
  { id: "na-6", bucket: "outcome:NO_ANSWER", level: "raw", text: "No answer. They're staring at an unknown number like it's a fucking landmine. Dial the next one." },
  { id: "na-7", bucket: "outcome:NO_ANSWER", level: "raw", text: "Nothing. Their phone works, their nerve doesn't. Not your shit to carry." },

  // --- Voicemail ------------------------------------------------------------------------------
  { id: "vm-1", bucket: "outcome:VOICEMAIL", level: "clean", text: "Your message now sits in a box that gets emptied the day they die, and not before." },
  { id: "vm-2", bucket: "outcome:VOICEMAIL", level: "clean", text: "Voicemail. You just performed for a robot, and you were good." },
  { id: "vm-3", bucket: "outcome:VOICEMAIL", level: "clean", text: "Beep. Congratulations, you are now background noise in somebody's commute." },
  { id: "vm-4", bucket: "outcome:VOICEMAIL", level: "salty", text: "Voicemail again. At this rate you've got a damn podcast." },
  { id: "vm-5", bucket: "outcome:VOICEMAIL", level: "raw", text: "Left a message at {business}. It'll rot in there next to nineteen others from people who also wanted to hand them fucking money." },
  { id: "vm-6", bucket: "outcome:VOICEMAIL", level: "raw", text: "Straight to voicemail. Thirty seconds of your best work, delivered to a machine that doesn't give a shit. Again." },

  // --- Connected ------------------------------------------------------------------------------
  { id: "cx-1", bucket: "outcome:CONNECTED", level: "clean", text: "You got a human. Real one. Endangered species." },
  { id: "cx-2", bucket: "outcome:CONNECTED", level: "clean", text: "Connected. That is further than most people get before lunch." },
  { id: "cx-3", bucket: "outcome:CONNECTED", level: "salty", text: "A live one. They picked up, which already makes them braver than the last dozen." },
  { id: "cx-4", bucket: "outcome:CONNECTED", level: "raw", text: "Talked to an actual person. In this economy that's practically a fucking miracle." },

  // --- Interested -----------------------------------------------------------------------------
  { id: "in-1", bucket: "outcome:INTERESTED", level: "clean", text: "Interested. Savour it — the universe is already queuing up your next fourteen no-answers." },
  { id: "in-2", bucket: "outcome:INTERESTED", level: "clean", text: "{business} wants to hear more. That's a pulse. Work it before it cools." },
  { id: "in-3", bucket: "outcome:INTERESTED", level: "salty", text: "Interest, out of nowhere. Hell of a thing." },
  { id: "in-4", bucket: "outcome:INTERESTED", level: "raw", text: "They're interested. Holy shit. Do not fumble this." },

  // --- Follow-up ------------------------------------------------------------------------------
  { id: "fu-1", bucket: "outcome:FOLLOW_UP", level: "clean", text: "A maybe. Maybes are where deals go to nap, not to die. Wake it up later." },
  { id: "fu-2", bucket: "outcome:FOLLOW_UP", level: "clean", text: "Booked to try again. Persistence is just politeness with a calendar." },
  { id: "fu-3", bucket: "outcome:FOLLOW_UP", level: "salty", text: "\"Call me next week.\" The polite version of go away. Prove them wrong." },
  { id: "fu-4", bucket: "outcome:FOLLOW_UP", level: "raw", text: "Another week, another chance for {business} to keep bleeding money the slow way. Diary it." },

  // --- Appointment ----------------------------------------------------------------------------
  { id: "ap-1", bucket: "outcome:APPOINTMENT", level: "clean", text: "Appointment booked. Now they get to ignore a calendar invite instead of a phone. Progress." },
  { id: "ap-2", bucket: "outcome:APPOINTMENT", level: "clean", text: "On the calendar. That's the entire job, done once. Now do it again." },
  { id: "ap-3", bucket: "outcome:APPOINTMENT", level: "salty", text: "Meeting with {business}. Somebody in that building is about to look very clever to their boss." },
  { id: "ap-4", bucket: "outcome:APPOINTMENT", level: "raw", text: "Meeting booked. Write that shit in ink." },

  // --- Not interested -------------------------------------------------------------------------
  { id: "ni-1", bucket: "outcome:NOT_INTERESTED", level: "clean", text: "They said no to revenue, to growth, and to you. Two of those are their problem." },
  { id: "ni-2", bucket: "outcome:NOT_INTERESTED", level: "clean", text: "A clean no. Refreshing, honestly — most of them just lie until you hang up." },
  { id: "ni-3", bucket: "outcome:NOT_INTERESTED", level: "clean", text: "{business} passed. History is a long list of people who passed on things." },
  { id: "ni-4", bucket: "outcome:NOT_INTERESTED", level: "salty", text: "No thanks, they said, from inside a business held together with tape and hope." },
  { id: "ni-5", bucket: "outcome:NOT_INTERESTED", level: "raw", text: "Not interested. They'll be extremely fucking interested in eighteen months when their competitor eats them. Next." },
  { id: "ni-6", bucket: "outcome:NOT_INTERESTED", level: "raw", text: "No. Some people would rather drown than take the rope, and that is not your shit to fix." },

  // --- Wrong number ---------------------------------------------------------------------------
  { id: "wn-1", bucket: "outcome:WRONG_NUMBER", level: "clean", text: "Wrong number. Bad data, not a bad call. Bin it and move." },
  { id: "wn-2", bucket: "outcome:WRONG_NUMBER", level: "clean", text: "Not them. You just cold-called a total stranger and survived it. Most people can't say that." },
  { id: "wn-3", bucket: "outcome:WRONG_NUMBER", level: "salty", text: "Dud number. Whoever typed that into the list owes you forty seconds of your life back." },
  { id: "wn-4", bucket: "outcome:WRONG_NUMBER", level: "raw", text: "Wrong number. The list lied to you. Lists do that, the little bastards." },

  // --- Mood: nothing dialled yet ---------------------------------------------------------------
  { id: "ms-1", bucket: "mood:not-started", level: "clean", text: "Zero calls. The phone will not disappoint you on its own — that takes initiative." },
  { id: "ms-2", bucket: "mood:not-started", level: "clean", text: "Empty day. So is the calendar of everyone you're about to interrupt." },
  { id: "ms-3", bucket: "mood:not-started", level: "clean", text: "Nothing yet. Somewhere out there your best deal of the month is sitting in a chair, bored, waiting for a phone to ring." },
  { id: "ms-4", bucket: "mood:not-started", level: "salty", text: "No calls. The list isn't going to dial itself and nobody's coming to do it for you." },
  { id: "ms-5", bucket: "mood:not-started", level: "raw", text: "Zero. The worst call of your day is the one you haven't made yet, so get the fucker over with." },

  // --- Mood: in progress -----------------------------------------------------------------------
  { id: "mp-1", bucket: "mood:progress", level: "clean", text: "{dials} down. Every one a small tax on the universe's patience." },
  { id: "mp-2", bucket: "mood:progress", level: "clean", text: "The machine is warm. Keep feeding it." },
  { id: "mp-3", bucket: "mood:progress", level: "salty", text: "{dials} calls in. The odds are grinding in your favour whether they like it or not." },
  { id: "mp-4", bucket: "mood:progress", level: "raw", text: "{dials} done. Nobody's coming to save the day, so you might as well finish the damn thing yourself." },

  // --- Mood: behind pace -----------------------------------------------------------------------
  { id: "mb-1", bucket: "mood:behind", level: "clean", text: "Behind pace. The day doesn't care and neither do they. Dial." },
  { id: "mb-2", bucket: "mood:behind", level: "clean", text: "You're short. The maths is simple and it's still winnable — it just costs the afternoon." },
  { id: "mb-3", bucket: "mood:behind", level: "salty", text: "Behind. Fix it now or explain it later, and one of those is a hell of a lot more fun." },
  { id: "mb-4", bucket: "mood:behind", level: "raw", text: "You're behind. Nothing to do about that except pick up the fucking phone, so pick up the phone." },

  // --- Mood: target reached ---------------------------------------------------------------------
  { id: "mr-1", bucket: "mood:reached", level: "clean", text: "Target hit. Go be insufferable about it." },
  { id: "mr-2", bucket: "mood:reached", level: "clean", text: "Done. Everything past this point is overtime for the ego." },
  { id: "mr-3", bucket: "mood:reached", level: "salty", text: "Goal's dead. You killed it. Anything more is showing off, which is allowed." },
  { id: "mr-4", bucket: "mood:reached", level: "raw", text: "Target's done. Anything after this is pure spite, and spite closes deals." },

  // --- Mood: no target set ----------------------------------------------------------------------
  { id: "mn-1", bucket: "mood:no-target", level: "clean", text: "No target today. The calls still count, and so does the practice." },
  { id: "mn-2", bucket: "mood:no-target", level: "clean", text: "No number to hit. Invent one, beat it, tell nobody." },
  { id: "mn-3", bucket: "mood:no-target", level: "salty", text: "No target set, which means the only person keeping score is you. Rough judge, that one." },
  { id: "mn-4", bucket: "mood:no-target", level: "raw", text: "No target. Make some calls anyway — the alternative is sitting here thinking about your life." },

  // --- Milestones -------------------------------------------------------------------------------
  { id: "mt-1", bucket: "milestone:ten", level: "clean", text: "{dials} calls. That many people now know your name and would deny it under oath." },
  { id: "mt-2", bucket: "milestone:ten", level: "clean", text: "{dials} down. The first ten are the worst ten. It gets stupider from here, not harder." },
  { id: "mt-3", bucket: "milestone:ten", level: "salty", text: "{dials} calls deep. Your voice is holding up better than their excuses." },
  { id: "mt-4", bucket: "milestone:ten", level: "raw", text: "{dials} calls. That's a solid morning of being politely told to piss off, and you're still here." },
  { id: "mt-5", bucket: "milestone:ten", level: "clean", text: "Another ten done. Nobody claps for this part. It's still the part that works." },
  { id: "mt-6", bucket: "milestone:ten", level: "raw", text: "Ten more. The grind is stupid, relentless and undefeated, and you're still standing in it." },

  { id: "mh-1", bucket: "milestone:half", level: "clean", text: "Halfway. The back nine is identical, except your voice is worse." },
  { id: "mh-2", bucket: "milestone:half", level: "clean", text: "Half the target, gone. The hard half was this one." },
  { id: "mh-3", bucket: "milestone:half", level: "salty", text: "Halfway there. Hell of a lot closer than the people who are still \"researching the market\"." },
  { id: "mh-4", bucket: "milestone:half", level: "raw", text: "Half done. Same again and you can go be a person, so let's not drag this shit out." },

  { id: "mg-1", bucket: "milestone:goal", level: "clean", text: "Target hit. The machine is fed. Go on, gloat a little." },
  { id: "mg-2", bucket: "milestone:goal", level: "clean", text: "Goal reached. Whatever you do next today is a bonus round." },
  { id: "mg-3", bucket: "milestone:goal", level: "salty", text: "Target's done and it's not even dark out. Bloody good." },
  { id: "mg-4", bucket: "milestone:goal", level: "raw", text: "Goal. Fucking. Hit. Everything after this is for the scoreboard." },
];
