<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Funnel McQueen CRM: project rules

- Product spec: `docs/SPEC.md`. Build contract (schema, RPCs, layout, conventions): `docs/ARCHITECTURE.md`. Read both before changing code.
- Agent isolation is non-negotiable and enforced in Postgres (RLS + guarded RPCs). Never rely on UI hiding.
- Log every intentional difference from the spec in `docs/DEVIATIONS.md`.
- There is no Docker. The local Supabase is `localbase/` (PGlite + PostgREST/GoTrue subset). Tests: `npm run verify`.
- Windows machine: use forward slashes in scripts, `cross-env`-free npm scripts (Node `--env-file`), LF line endings.
