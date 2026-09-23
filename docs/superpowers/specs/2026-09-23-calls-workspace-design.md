# Calls Workspace Design

## Goal

Make inbound calls visible and actionable in the CRM through a main-navigation Calls page. Agents see their own call history; admins can see the entire team.

## Page

The page has All, Missed, and Voicemail tabs. Each row shows direction, caller or lead, time, outcome, duration, and a callback action. Calls linked to a lead open that lead; calls without a lead remain visible as Unknown caller.

## Access and data

The page reads the existing calls, leads, profiles, and voicemail data. It does not create duplicate call records or add another Twilio integration. Agents are limited to calls assigned to them. Admins can filter by agent. Filter and tab state lives in the URL.

## Interaction and responsive behavior

Missed inbound calls and unheard voicemails receive a clear state treatment. Callback uses the existing dialer. On mobile, rows become compact tappable cards; desktop uses a table. The Calls item is available from the main navigation for every signed-in user.

## Errors and testing

An empty state explains when no calls match the filters. Existing access rules are enforced on the server. Tests cover agent/admin visibility, tabs and URL filters, unknown callers, callback data, and mobile rendering.
