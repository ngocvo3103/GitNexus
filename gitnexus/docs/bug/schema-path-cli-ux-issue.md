# Bug: `--schema-path` CLI Option Requires Argument, Cannot Use Bundled Schema in Warn-Only Mode

**Date:** 2026-04-01  
**Severity:** Medium (UX Issue)  
**Component:** `gitnexus/src/cli/tool.ts`, `gitnexus/src/cli/index.ts`

## Summary

The `--schema-path` CLI option requires a file path argument, making it impossible to trigger bundled schema validation in warn-only mode. Users can only get bundled schema validation with `--strict` (which exits on failure).

## Current Behavior

### CLI Option Definition
```typescript
// gitnexus/src/cli/index.ts:137
.option('--schema-path <path>', 'Path to custom JSON schema file (default: bundled schema)')
```

### Validation Logic
```typescript
// gitnexus/src/cli/tool.ts:199-214
if (options.schemaPath || options.strict) {
  const { validateAgainstSchema, formatValidationErrors } = await import('../utils/schema-validator.js');
  const validation = validateAgainstSchema(result, undefined, options.schemaPath);

  if (!validation.valid) {
    const errorMsg = `Schema validation failed:\n${formatValidationErrors(validation)}`;

    if (options.strict) {
      console.error(errorMsg);
      process.exit(1);
    } else {
      console.error(`Warning: ${errorMsg}`);
    }
  }
}
```

### Observed Behavior

| Command | Result |
|---------|--------|
| `gitnexus document-endpoint --strict` | ✅ Bundled schema validation, exits 1 on failure |
| `gitnexus document-endpoint --schema-path` | ❌ Error: `option '--schema-path <path>' argument missing` |
| `gitnexus document-endpoint --schema-path /custom/schema.json` | ✅ Custom schema validation, warns on failure |

## User Expectation

Users expected `--schema-path` to work as a boolean flag to enable bundled schema validation without `--strict` (i.e., warn-only mode):

```bash
# Expected: Use bundled schema, warn on validation errors
gitnexus document-endpoint --schema-path
```

## Root Cause

Commander.js `<path>` syntax requires an argument. The validation logic at `tool.ts:200` checks `options.schemaPath || options.strict`, suggesting the intent was to support `--schema-path` as an optional flag. However, Commander.js fails parsing before reaching this code.

## Proposed Fix

Change the CLI option to use optional argument syntax:

```typescript
// gitnexus/src/cli/index.ts
.option('--schema-path [path]', 'Path to custom JSON schema file (omit to use bundled schema)')
```

With `[path]` (brackets instead of angle brackets), the argument becomes optional:
- `--schema-path` → Uses bundled schema
- `--schema-path /custom/schema.json` → Uses custom schema

## Workaround

Use `--strict` for bundled schema validation:

```bash
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --strict
```

## Test Commands Used

```bash
# Test 1: With context (PASS)
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --include-context

# Test 2: No context (PASS)
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest"

# Test 3: Schema non-strict (FAIL - missing argument)
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --schema-path

# Test 4: Strict (PASS)
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --strict

# Test 5: OpenAPI mode (PASS)
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --openapi
```

## Related Files

- `gitnexus/src/cli/index.ts:137` - CLI option definition
- `gitnexus/src/cli/tool.ts:199-214` - Validation logic
- `gitnexus/src/utils/schema-validator.ts` - Schema loading and validation
