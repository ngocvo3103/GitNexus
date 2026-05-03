# Fix: document-endpoint includes own endpoint as downstream API dependency

**Type:** Bug
**Created:** 2026-05-01
**Status:** in progress

## Summary

The `document-endpoint` tool resolves the endpoint's own controller as a downstream API dependency using a class-name heuristic, resulting in the endpoint appearing to call itself.

## Context

When no actual downstream API call is detected, the class-name heuristic takes the controller class name (e.g., `BondExtController`) and derives a service name (`bond-ext`). This produces a circular self-reference in `downstreamApis`. Fix: pass the current controller name to `extractDownstreamApis` and skip the class-name heuristic when it would produce the same service name as the current endpoint's controller. GitHub issue: #35.

## Implementation Summary

- **WI-1**: Added `currentController?: string` parameter to `extractDownstreamApis` in `document-endpoint.ts`. Added self-reference exclusion check in class-name heuristic section: if `serviceNameFromClassName(currentController) === derived`, skip (continue). Updated `buildDocumentation` call site to pass `route.controller` as `currentController`.
- **WI-2**: Unit tests for self-reference exclusion (in progress).