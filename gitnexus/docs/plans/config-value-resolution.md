# Config Value Resolution — Implementation Plan

**Type:** Feature Enhancement
**Risk:** LOW
**Related:** `gitnexus/docs/bug/unresolved-service-urls.md`

## Understanding

Property nodes already exist in the graph with actual values from config files (`application.yml/properties`). The gap is a simple query function to look up Property nodes by key. The current `resolveValueAnnotation()` extracts the property KEY from `@Value` annotations but doesn't query Property nodes for the actual value.

## Solution: Add `resolvePropertyValue()` Function

```
Current:  @Value("${tcbs.bond.product.url}") → propertyKey: "tcbs.bond.product.url"
                                                               ↓
Enhanced:                                          resolvePropertyValue()
                                                               ↓
                                          actual value: "http://bond-product:8080/v1"
```

## Cross-Stack Checklist

- [x] Backend changes? Yes — `document-endpoint.ts` - one new function
- [x] Frontend changes? No — Transparent to callers
- [x] Contract mismatches? No — `resolvedValue` is new optional field
- [x] Deployment order? N/A — Single service

## Work Items

### WI-1: Add `resolvePropertyValue()` function [P0]

**Files:** `src/mcp/local/document-endpoint.ts`
**What:** Query Property nodes by key and return actual values
**Reuse:** `executeQuery` callback pattern from `resolveValueAnnotation`

### WI-2: Integrate into Pass 1 resolution [P0]

**Files:** `src/mcp/local/document-endpoint.ts`
**What:** After `resolveValueAnnotation()` returns propertyKey, call `resolvePropertyValue()`
**Reuse:** Existing multi-pass resolution framework

### WI-3: Support `${key:default}` syntax [P1]

**Files:** `src/mcp/local/document-endpoint.ts`
**What:** Parse default value syntax and use if Property not found

## Acceptance Criteria

- [ ] Given `@Value("${tcbs.bond.product.url}")`, when Property node exists, then `resolvedValue` contains actual URL
- [ ] Given property key not found, when resolution runs, then `resolvedValue` is `null`
- [ ] Regression suite green
- [ ] E2E test shows `resolvedValue` for resolved services