---
name: project-go-cross-file-implements-wi-h85
description: WI-H85 (issue #85) added a two-pass Go IMPLEMENTS detector — pre-pass global interface registry, per-file cross-file match at confidence 0.7 with reason 'cross-file-structural-match'
metadata:
  type: project
---

WI-H85 (issue #85) shipped the cross-file Go IMPLEMENTS detector. The same-file detector (`collectGoImplementsHeritage` in `gitnexus/src/core/ingestion/workers/go-relationships.ts`) was unchanged; a new sibling `collectGoImplementsCrossFile` was added with a pre-pass `collectGoInterfaceMethods` that builds a global interface method registry across the file group.

**Why:** Issue #85 reports a `UserService` in `services/user_service.go` implements `IUserService` in `interfaces/service_interface.go` with no IMPLEMENTS edge emitted. The same-file detector cannot see cross-file pairs by design.

**How to apply:** When adding new cross-file detectors in `go-relationships.ts`, follow the same two-pass pattern (pre-pass registry, per-file match) and emit at a lower confidence with a `reason` that distinguishes cross-file from same-file. The two-pass is wired in BOTH `heritage-processor.ts` (AST path) and `parse-worker.ts` (worker path). The cross-file confidence is 0.7 and the reason is `'cross-file-structural-match'`. The same-file pairs are deduped via a `sameFilePairs` Set passed into `collectGoImplementsCrossFile`. v1 uses name-only method comparison (signature matching is the v2 work item). The cross-file emission in `processHeritageFromExtracted` parses the `kind` string as `cross-file-implements|<parentFilePath>|<confidence>` to recover the cross-file metadata. The new fixture is at `gitnexus/test/fixtures/lang-resolution/go-implements-cross-file/` and the integration test is `go-implements-cross-file.test.ts` (6 tests).
