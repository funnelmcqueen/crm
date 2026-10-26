# Reconnecting call workflow implementation plan

Goal: Replace the current restaurant callback pitch with the workflow approved in chat.

Scope: copy only; retain current layout, stage IDs, booking integration, permissions and telephony.

- Update the domain playbook and personalized greeting to v4: reconnect, check timing, explain customer benefit, book a 20-minute video meeting, confirm email and timezone.
- Update English and German playbook messages, including objections and manual calendar/email handoff. Remove unsupported commercial claims and SMS instructions.
- Update existing playbook expectations; run npm run verify and review the diff.
- Package the change for review. The connected GitHub account currently has no push permission on funnelmcqueen/crm.
