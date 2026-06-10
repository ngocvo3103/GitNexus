---
name: feedback-kuzu-alter-table-no-if-not-exists
description: Kùzu (LadybugDB) ALTER TABLE does NOT support ADD COLUMN or IF NOT EXISTS — use `ALTER TABLE X ADD col TYPE` and rely on error suppression for idempotency
metadata:
  type: feedback
---

Kùzu (LadybugDB 0.15.2) `ALTER TABLE` syntax constraints:
- `ADD COLUMN` keyword is **rejected at parse time** — Kùzu parses `ADD` then expects the column name directly. Use `ALTER TABLE X ADD col TYPE` (no `COLUMN`).
- `IF NOT EXISTS` is **NOT supported** in `ALTER TABLE` (Kùzu has no equivalent of Postgres' `ADD COLUMN IF NOT EXISTS`).
- Re-running a successful ADD on the same column throws: `Runtime exception: <Table> table already has property <col>.` (NOT "already exists").
- The error-suppression loop in `lbug-adapter.doInitLbug` (WI-160) catches both `already has property` and `already exists` to keep the migration runner idempotent across fresh and existing DBs.

**Why:** Original 30 `*_MIGRATION` constants in `schema.ts` used the invalid `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern. They were exported as dead code for months and the bug never surfaced because `doInitLbug` never invoked them. WI-160 wired the runner and immediately hit the parse error. Fix: drop `COLUMN` and `IF NOT EXISTS` from every migration string; keep the runner's catch block.

**How to apply:** When writing a new `*_MIGRATION` constant in `schema.ts`, use plain `ALTER TABLE X ADD col TYPE` (one statement per line for multi-statement migrations). Do not add `IF NOT EXISTS` — it will throw and the runner's catch block is the idempotency guard. Verify with a quick `conn.query()` smoke test before committing.
