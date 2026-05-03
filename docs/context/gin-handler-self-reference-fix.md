# Backend Spec: Go/Gin Handler→Service CALLS Edge Resolution Fix

## Overview

Fix the Go/Gin call processor to correctly resolve handler→service method calls through struct field types, instead of creating self-referencing CALLS edges.

## Current Behavior

1. Go handler `OrderHandler.GetOrder()` calls `h.service.GetOrder()`
2. The call processor extracts `calledName="GetOrder"` with `callForm="member"`
3. `extractMixedChain` should extract chain `[{kind:'field',name:'service'}]` with base `h`
4. `walkMixedChain` should resolve `h` → `OrderHandler`, then `service` field → `OrderService`
5. **Bug**: The resolution either doesn't extract the mixed chain, or fails to resolve the field type, causing `receiverTypeName` to default to the handler's own type

**Result**: CALLS edge `OrderHandler.GetOrder → OrderHandler.GetOrder` (self-reference) instead of `OrderHandler.GetOrder → OrderService.GetOrder`

## Proposed Behavior

### Mixed Chain Resolution Fix (WI-1)

The fix targets the specific gap in the call resolution pipeline where Go struct field accesses lose their type information. The exact fix location depends on the debug findings:

**Scenario A**: If `extractMixedChain` is not extracting the chain for Go selector expressions:
- Fix: Ensure Go tree-sitter queries produce the correct chain format for `selector_expression` nodes
- Location: `call-processor.ts` lines 472-541

**Scenario B**: If `walkMixedChain` resolves `h` → `OrderHandler` but fails on `service` → `OrderService`:
- Fix: Ensure `resolveFieldAccessType` looks up the struct's Property nodes to find the field's `declaredType`
- Location: `call-processor.ts` lines 1129-1144

**Scenario C**: If `receiverTypeName` is populated but with the wrong type (handler instead of service):
- Fix: Ensure the type environment correctly propagates struct field types from Go's `field_declaration` nodes
- Location: `type-env.ts` and `type-extractors/go.ts`

### Testing Approach

After fixing, verify with `sample-gin` fixture that:
1. `OrderHandler.GetOrder` has a CALLS edge to `OrderService.GetOrder`
2. `OrderHandler.DeleteOrder` has a CALLS edge to `OrderService.DeleteOrder`
3. No self-referencing CALLS edges exist for handler methods

## Business Rules

1. **Handler→service resolution**: When a handler method calls `h.service.Method()`, the CALLS edge must point to the service method, not the handler method
2. **Interface resolution**: When the service field is an interface type, resolve to the concrete implementation using the existing D5 logic
3. **Backward compatibility**: Other language resolution must be unaffected
4. **Fallback behavior**: If mixed chain resolution fails, fall back to current behavior (no worse than before)

## Response Shape

No change to CALLS edge structure. The fix changes which node a CALLS edge points to, not the edge schema itself.