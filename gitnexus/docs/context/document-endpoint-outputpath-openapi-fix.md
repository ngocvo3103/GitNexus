# document-endpoint outputPath openapi mode fix

**Service:** GitNexus CLI
**Status:** Draft

## Summary

The `--outputPath` flag crashes when used with `--mode openapi` because the code assumes the result is always a `DocumentEndpointResult` (which has `specs`) but receives an `OpenApiModeResult` (which has pre-generated `yaml` string instead).

## Request

### Path parameters
N/A (CLI command, not HTTP)

### Command
```bash
node dist/cli/index.js document-endpoint \
  --method PUT --path '/e/v1/bookings/{productCode}/suggest' \
  --mode openapi --repo tcbs-bond-trading --outputPath /tmp/test
```

## Response

### Expected behavior after fix

**When mode=openapi + outputPath:**
1. Write `result.yaml` (from `OpenApiModeResult`) directly to `{outputPath}/{baseName}.yaml`
2. Write a JSON metadata file to `{outputPath}/{baseName}.json` containing `{ method, path, handlerClass, handlerMethod }` from `OpenApiModeResult`
3. Do NOT call `convertToOpenAPIDocument` — the YAML is already generated

**When mode=ai_context + outputPath:**
1. Keep existing behavior: call `convertToOpenAPIDocument([result])` to generate YAML from `DocumentEndpointResult`
2. Write JSON output (result) and YAML output as before
3. Strip `undefined` values from JSON output (WI-7)

## Error responses

| Condition | Behavior |
|-----------|----------|
| `outputPath` dir doesn't exist | Create it with `fs.mkdirSync({ recursive: true })` |
| `result` is `OpenApiModeResult` + no `yaml` field | Throw error with clear message |

## Business rules

- Mode detection: check `'yaml' in result` (type guard for `OpenApiModeResult`)
- JSON output for openapi mode should be a useful metadata object, not the raw `OpenApiModeResult`
- `convertToOpenAPIDocument` must NEVER be called with `OpenApiModeResult` — it expects `DocumentEndpointResult[]`
- ai_context mode behavior with `--outputPath` remains unchanged (existing working path)

## Notes

- Zero existing test coverage for `--outputPath` flag
- MCP tool (`tools.ts`) has no `outputPath` parameter — this bug only affects CLI
- The `OpenApiModeResult` type is: `{ yaml: string; method: string; path: string; handlerClass?: string; handlerMethod?: string }`