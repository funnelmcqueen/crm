import "server-only";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

export const TWILIO_WEBHOOK_PATHS = {
  outbound: "/api/twilio/voice/outbound",
  dialComplete: "/api/twilio/voice/dial-complete",
  status: "/api/twilio/voice/status",
  inbound: "/api/twilio/voice/inbound",
  inboundDialComplete: "/api/twilio/voice/inbound-dial-complete",
  voicemailComplete: "/api/twilio/voice/voicemail-complete",
  recordingStatus: "/api/twilio/voice/recording-status",
} as const;

export const FAILURE_MESSAGE = "Sorry, this call cannot be completed.";
export const GOODBYE_MESSAGE = "Thank you. Goodbye.";

export function webhookUrl(appBaseUrl: string, path: (typeof TWILIO_WEBHOOK_PATHS)[keyof typeof TWILIO_WEBHOOK_PATHS]): string {
  return `${appBaseUrl.replace(/\/+$/, "")}${path}`;
}

/** Outbound bridge from the agent's browser to the lead's number. */
export function outboundDialTwiml(input: { appBaseUrl: string; callerId: string; to: string }): string {
  const response = new VoiceResponse();
  const dial = response.dial({
    callerId: input.callerId,
    timeout: 30,
    answerOnBridge: true,
    action: webhookUrl(input.appBaseUrl, TWILIO_WEBHOOK_PATHS.dialComplete),
  });
  dial.number(
    {
      statusCallback: webhookUrl(input.appBaseUrl, TWILIO_WEBHOOK_PATHS.status),
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    },
    input.to,
  );
  return response.toString();
}

/** Rings the agent's registered Device; the browser reads the call id from the custom parameter. */
export function ringClientTwiml(input: { appBaseUrl: string; identity: string; callId: string }): string {
  const response = new VoiceResponse();
  const dial = response.dial({
    timeout: 20,
    answerOnBridge: true,
    action: webhookUrl(input.appBaseUrl, TWILIO_WEBHOOK_PATHS.inboundDialComplete),
  });
  const client = dial.client();
  client.identity(input.identity);
  client.parameter({ name: "callId", value: input.callId });
  return response.toString();
}

export function voicemailTwiml(input: { appBaseUrl: string; greeting: string }): string {
  const response = new VoiceResponse();
  response.say(input.greeting);
  response.record({
    maxLength: 120,
    playBeep: true,
    action: webhookUrl(input.appBaseUrl, TWILIO_WEBHOOK_PATHS.voicemailComplete),
    recordingStatusCallback: webhookUrl(input.appBaseUrl, TWILIO_WEBHOOK_PATHS.recordingStatus),
    recordingStatusCallbackEvent: ["completed"],
  });
  return response.toString();
}

/** Never explains why (SPEC 7a). */
export function failureTwiml(): string {
  const response = new VoiceResponse();
  response.say(FAILURE_MESSAGE);
  response.hangup();
  return response.toString();
}

export function emptyTwiml(): string {
  return new VoiceResponse().toString();
}

export function goodbyeTwiml(): string {
  const response = new VoiceResponse();
  response.say(GOODBYE_MESSAGE);
  response.hangup();
  return response.toString();
}

export function twimlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}
