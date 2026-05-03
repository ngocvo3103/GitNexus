# Fix: Go/Gin handler CALLS edges self-reference handler methods instead of service methods

**Type:** Bug
**Created:** 2026-05-02
**Status:** in progress

## Summary

Go/Gin handler methods create self-referencing CALLS edges instead of pointing to the service methods they call. When `OrderHandler.GetOrder()` calls `h.service.GetOrder()`, the CALLS edge should point to `OrderService.GetOrder` but instead points back to `OrderHandler.GetOrder`.

## Context

Root cause: The call processor's mixed chain resolution (`walkMixedChain`) fails to resolve Go struct field types correctly. When `h.service.GetOrder()` is extracted, the chain resolution should walk `h` → `OrderHandler`, then `service` → `OrderService`, but it falls back to the handler's own type. GitHub issue: #19.

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/gin-handler-self-reference-fix.md` |
| Solution design | `docs/designs/gin-handler-self-reference-fix-solution-design.md` |
| Backend spec | `docs/context/gin-handler-self-reference-fix.md` |