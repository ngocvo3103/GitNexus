// LOCAL-ONLY E2E — requires tcbs-bond-trading repos on local filesystem.
// Run manually: npx vitest run test/integration/document-endpoint-all.test.ts
// Do NOT commit to CI. Delete manually after verification.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { createRequire } from 'module';
import yaml from 'js-yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

// Absolute file:// URL to tsx loader — needed when spawning CLI with cwd
// outside the project tree (bare 'tsx' specifier won't resolve there).
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

const PROJECT_PATHS = [
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading',
  '/Users/NgocVo_1/Documents/sourceCode/bond-exception-handler',
  '/Users/NgocVo_1/Documents/sourceCode/matching-engine-client',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp-message',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading-core',
];

function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

describe('document-endpoint --all E2E', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Analyze each project so the graph index is populated before --all runs.
    // --all reads from the local graph index (LadybugDB), not from source files.
    for (const projectPath of PROJECT_PATHS) {
      if (!fs.existsSync(projectPath)) continue;
      const result = runCliRaw(['analyze', projectPath], projectPath, 300000);
      // Don't fail beforeAll — log and continue
      if (result.status !== 0 && result.status !== null) {
        console.warn(`analyze warning for ${projectPath}:`, result.stderr.slice(0, 200));
      }
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-all-'));
  }, 300000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: Happy path ───────────────────────────────────────────

  it('P0: --all --repo tcbs-bond-trading --outputPath writes .openapi.yaml files', async () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path not found: ${projectPath}. Cannot run local-only E2E.`);
    }

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading', '--outputPath', tmpDir],
      projectPath,
      300000,
    );

    if (result.status === null) throw new Error('CLI timed out');

    // Accept exit 0 (all succeeded) or exit 1 (some endpoints failed, but batch completed)
    expect([0, 1], `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toContain(result.status);

    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    expect(yamlFiles.length).toBeGreaterThan(0);
  }, 300000);

  // ─── Test 2: YAML validity ────────────────────────────────────────

  it('P0: each YAML file is valid openapi 3.1.0 with paths key', () => {
    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    expect(yamlFiles.length).toBeGreaterThan(0);

    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(tmpDir, file), 'utf8');
      let parsed: Record<string, unknown> = {};
      expect(() => { parsed = yaml.load(content) as Record<string, unknown>; }).not.toThrow();
      expect(parsed).toHaveProperty('openapi', '3.1.0');
      expect(parsed).toHaveProperty('paths');
    }
  }, 60000);

  // ─── Test 3: Filename convention ──────────────────────────────────

  it('P1: filenames match METHOD_path.openapi.yaml convention', () => {
    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    const methodPathRegex = /^[A-Z]+_.+\.openapi\.yaml$/;

    for (const file of yamlFiles) {
      expect(file).toMatch(methodPathRegex);
      expect(file).not.toMatch(/[\/{} ]/);
    }
  }, 30000);

  // ─── Test 4: Progress output ──────────────────────────────────────

  it('P1: stderr contains Written: progress indicator', async () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return; // already validated in test 1

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading', '--outputPath', tmpDir],
      projectPath,
      300000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect([0, 1]).toContain(result.status);
    expect(result.stderr).toMatch(/Written:/);
  }, 300000);

  // ─── Test 5: Mutual exclusion --all + --method ────────────────────

  it('P1: --all + --method is rejected (mutually exclusive)', () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return;

    const result = runCliRaw(
      [
        'document-endpoint',
        '--all',
        '--method', 'GET',
        '--path', '/foo',
        '--repo', 'tcbs-bond-trading',
        '--outputPath', tmpDir,
      ],
      projectPath,
      30000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(
      combined.toLowerCase().includes('mutually exclusive') ||
      combined.toLowerCase().includes('cannot be used with') ||
      combined.toLowerCase().includes('--method'),
    ).toBe(true);
  }, 30000);

  // ─── Test 6: --all requires --outputPath ──────────────────────────

  it('P1: --all without --outputPath is rejected', () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return;

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading'],
      projectPath,
      30000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toMatch(/required|outputPath|missing/i);
  }, 30000);

  // ─── Quality Metrics ──────────────────────────────────────────────

  describe('quality metrics', () => {
    // Known unresolvable endpoints due to Java source limitations:
    // - 10 bare type:object:
    //     raw Object (3): voucher (branching DTOs), confirm, sign (branching DTOs)
    //     ResponseEntity<?> (2): value-by-productCode, iconnect-pro
    //     raw Map (2): ibond/origin external + internal
    //     List<Map> (3): contract/cds/download external + internal, cd-last-transaction
    // - 17 POST/PUT missing @RequestBody: endpoints with only @RequestParam/@PathVariable
    //     PathVariable only (8): certificates/download x2, combo x2, cancel, sign/extend, sign/swap, unhold-money-mortgage
    //     RequestParam only (4): handle-info, cds/expire x2, ibond/origin x2 (RequestParam Map)
    //     Zero business params (5): auto-cds x2, pre-order/expired x2, iconnect-pro
    // - 3 items:type:string: legitimate List<String> returns (trading-code, working-days, bonds/{tcbsId}/get Map<String,List<String>>)
    // These are Java-source limitations, not GitNexus bugs.
    const KNOWN_BARE_TYPE_OBJECT = 10;
    const KNOWN_MISSING_REQUEST_BODY = 17;
    const KNOWN_LEGITIMATE_ITEMS_STRING = 3;
    // Baseline for new metrics — these are floors, should only improve
    const BASELINE_DOWNSTREAM_APIS = 331;
    const BASELINE_OUTBOUND_MESSAGING = 64;
    const BASELINE_VALIDATION_RULES = 281;

    // ── Ceiling metrics (cannot improve without AI or config scanning) ──
    const CEILING_EXCHANGE_METHOD = 0;       // EXCHANGE method now excluded from downstream APIs
    const CEILING_UNKNOWN_SERVICE = 0;       // Variable name heuristic + proactive @Value scan + builder tracing + class name fallback
    const CEILING_CODE_EXPRESSION = 190;       // builder.toUriString() + concatenation resolution

    // ── Anomaly ceilings ──
    // A2: Path {param} without matching in:path parameter (tcbsId from JWT is unfixable)
    const CEILING_PATH_PARAM_MISMATCH = 5;
    // A4: Container without items (inner type unresolved)
    const CEILING_CONTAINER_WITHOUT_ITEMS = 128;
    // A5: Download endpoints without application/octet-stream
    const CEILING_DOWNLOAD_WITHOUT_OCTET = 26;
    // B1: Unresolved downstream endpoints (code expressions)
    const CEILING_UNRESOLVED_ENDPOINTS = 197;
    // B4: Inbound topic over-inclusion (shared base class — expected 341)
    const CEILING_INBOUND_TOPIC_ALL_FILES = 341;
    // B7: ID path params typed as string (may be correct for string IDs like tcbsId)
    const CEILING_ID_PATH_PARAM_STRING = 166;
    // B8: Endpoints without 400 response
    const CEILING_NO_400_RESPONSE = 48;

    /**
     * Parse all generated YAML files and compute quality metrics.
     */
    function computeMetrics(): {
      total: number;
      structured200: number;
      primitive200: number;
      bareObject200: number;
      getWithRequestBody: number;
      postPutMissingRequestBody: number;
      itemsTypeString: number;
      downstreamApisPresent: number;
      outboundMessaging: number;
      validationRules: number;
      unknownServiceCount: number;
      // Anomaly metrics
      pathParamMismatch: { file: string; path: string; braces: number; params: number }[];
      containerWithoutItems: number;
      downloadWithoutOctetStream: number;
      unresolvedEndpoints: number;
      inboundTopicAllFiles: number;
      idPathParamString: number;
      no400Response: number;
      bareObjectNoProps: number;
    } {
      const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
      let structured200 = 0;
      let primitive200 = 0;
      let bareObject200 = 0;
      let getWithRequestBody = 0;
      let postPutMissingRequestBody = 0;
      let itemsTypeString = 0;
      let downstreamApisPresent = 0;
      let outboundMessaging = 0;
      let validationRules = 0;
      let unknownServiceCount = 0;
      // Anomaly counters
      const pathParamMismatch: { file: string; path: string; braces: number; params: number }[] = [];
      let containerWithoutItems = 0;
      let downloadWithoutOctetStream = 0;
      let unresolvedEndpoints = 0;
      let inboundTopicAllFiles = 0;
      let idPathParamString = 0;
      let no400Response = 0;
      let bareObjectNoProps = 0;

      for (const file of yamlFiles) {
        const content = fs.readFileSync(path.join(tmpDir, file), 'utf8');

        // 200 response schema quality
        const resp200Match = content.match(/'200':[\s\S]*?(?=(?:'4\d{2}':|'5\d{2}':|operationId:))/);
        if (resp200Match) {
          const resp = resp200Match[0];
          const hasStructured = /properties:|additionalProperties:|\$ref:/.test(resp);
          const hasObjectType = /type: object/.test(resp);

          if (hasStructured) {
            structured200++;
          } else if (hasObjectType) {
            bareObject200++;
          } else if (/type:/.test(resp)) {
            primitive200++;
          }
        }

        // GET with requestBody (should be 0)
        const method = file.split('_')[0];
        if ((method === 'GET' || method === 'HEAD' || method === 'DELETE') && /requestBody:/.test(content)) {
          getWithRequestBody++;
        }

        // POST/PUT missing requestBody
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          if (!/requestBody:/.test(content)) {
            postPutMissingRequestBody++;
          }
        }

        // items: type: string (unresolved)
        if (/items:\s*\n\s+type:\s*string\s*$/m.test(content)) {
          itemsTypeString++;
        }

        // Downstream API docs present
        if (/x-downstream-apis:/.test(content)) {
          downstreamApisPresent++;
        }

        // Unknown-service count in downstream APIs
        const unknownMatches = content.match(/serviceName: unknown-service/g);
        if (unknownMatches) {
          unknownServiceCount += unknownMatches.length;
        }

        // Outbound messaging present
        if (/x-messaging-outbound:/.test(content)) {
          outboundMessaging++;
        }

        // Validation rules present
        if (/x-validation-rules:/.test(content)) {
          validationRules++;
        }

        // ═══════════════════════════════════════════════════════════════
        // ANOMALY DETECTION
        // ═══════════════════════════════════════════════════════════════

        // A2: Path {param} without matching in:path parameter
        const pathMatch = content.match(/^  (\/[^\n]+):/m);
        if (pathMatch) {
          const path = pathMatch[1];
          const braceCount = (path.match(/{/g) || []).length;
          const pathParamCount = (content.match(/in: path/g) || []).length;
          if (braceCount > pathParamCount) {
            pathParamMismatch.push({ file, path, braces: braceCount, params: pathParamCount });
          }
        }

        // A3: Bare type:object without properties (in schemas, not responses)
        // Count occurrences of "type: object" NOT followed by "properties:" within 3 lines
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/\btype: object\b/.test(lines[i]) && !lines[i].includes('#')) {
            let hasProps = false;
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
              if (/properties:/.test(lines[j])) {
                hasProps = true;
                break;
              }
              // Stop if we hit another key at same or lower indent
              if (lines[j].match(/^\s*[a-zA-Z]/) && !lines[j].includes('properties')) {
                break;
              }
            }
            if (!hasProps) bareObjectNoProps++;
          }
        }

        // A4: Container without items (type: array NOT followed by items:)
        for (let i = 0; i < lines.length; i++) {
          if (/\btype: array\b/.test(lines[i])) {
            let hasItems = false;
            for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
              if (/^\s*items:/.test(lines[j])) {
                hasItems = true;
                break;
              }
              if (lines[j].match(/^\s*[a-zA-Z]/) && !lines[j].includes('items')) {
                break;
              }
            }
            if (!hasItems) containerWithoutItems++;
          }
        }

        // A5: Download endpoints missing application/octet-stream
        if (file.toLowerCase().includes('download') && !content.includes('octet-stream')) {
          downloadWithoutOctetStream++;
        }

        // B1: Unresolved downstream endpoints (code expressions)
        const unresolvedMatches = content.match(/endpoint: (GET|POST|PUT|DELETE|PATCH) (targetUrl|url\.toString\(\)|targetUrl\.toString\(\)|url\.toUriString\(\)|\[internal\])/g);
        if (unresolvedMatches) {
          unresolvedEndpoints += unresolvedMatches.length;
        }

        // B4: Inbound topic over-inclusion (b.e.q.trading.005032 appears everywhere)
        if (content.includes('b.e.q.trading.005032')) {
          inboundTopicAllFiles++;
        }

        // B7: ID path params typed as string
        const idStringParams = content.match(/name: (\w*(?:id|Id|ID)\w*)\s*\n\s*in: path[\s\S]*?type: string/g);
        if (idStringParams) {
          idPathParamString += idStringParams.length;
        }

        // B8: Endpoints without 400 response
        if (!content.includes("'400'")) {
          no400Response++;
        }
      }

      return {
        total: yamlFiles.length,
        structured200,
        primitive200,
        bareObject200,
        getWithRequestBody,
        postPutMissingRequestBody,
        itemsTypeString,
        downstreamApisPresent,
        outboundMessaging,
        validationRules,
        unknownServiceCount,
        pathParamMismatch,
        containerWithoutItems,
        downloadWithoutOctetStream,
        unresolvedEndpoints,
        inboundTopicAllFiles,
        idPathParamString,
        no400Response,
        bareObjectNoProps,
      };
    }

    it('P0: no GET endpoint has requestBody', () => {
      const m = computeMetrics();
      expect(m.getWithRequestBody, 'GET with requestBody is a bug — must be 0').toBe(0);
    });

    it('P0: structured 200 responses >= 80% of total', () => {
      const m = computeMetrics();
      const pct = (m.structured200 / m.total) * 100;
      expect(pct, `Only ${m.structured200}/${m.total} (${pct.toFixed(1)}%) have structured 200 responses`).toBeGreaterThanOrEqual(80);
    });

    it('P1: bare type:object responses <= known unresolvable count', () => {
      const m = computeMetrics();
      expect(m.bareObject200,
        `${m.bareObject200} bare type:object — expected <= ${KNOWN_BARE_TYPE_OBJECT} (raw Object, ResponseEntity<?>, raw Map)`
      ).toBeLessThanOrEqual(KNOWN_BARE_TYPE_OBJECT);
    });

    it('P1: items:type:string <= known legitimate count', () => {
      const m = computeMetrics();
      expect(m.itemsTypeString,
        `${m.itemsTypeString} items:type:string — expected <= ${KNOWN_LEGITIMATE_ITEMS_STRING} (legit List<String>)`
      ).toBeLessThanOrEqual(KNOWN_LEGITIMATE_ITEMS_STRING);
    });

    it('P1: POST/PUT missing requestBody <= known count', () => {
      const m = computeMetrics();
      expect(m.postPutMissingRequestBody,
        `${m.postPutMissingRequestBody} missing requestBody — expected <= ${KNOWN_MISSING_REQUEST_BODY} (no @RequestBody in source)`
      ).toBeLessThanOrEqual(KNOWN_MISSING_REQUEST_BODY);
    });

    it('P1: downstream API docs >= baseline', () => {
      const m = computeMetrics();
      const pct = ((m.downstreamApisPresent / m.total) * 100).toFixed(1);
      expect(m.downstreamApisPresent,
        `${m.downstreamApisPresent}/${m.total} (${pct}%) have downstream API docs — expected >= ${BASELINE_DOWNSTREAM_APIS}`
      ).toBeGreaterThanOrEqual(BASELINE_DOWNSTREAM_APIS);
    });

    it('P1: outbound messaging >= baseline', () => {
      const m = computeMetrics();
      const pct = ((m.outboundMessaging / m.total) * 100).toFixed(1);
      expect(m.outboundMessaging,
        `${m.outboundMessaging}/${m.total} (${pct}%) have outbound messaging — expected >= ${BASELINE_OUTBOUND_MESSAGING}`
      ).toBeGreaterThanOrEqual(BASELINE_OUTBOUND_MESSAGING);
    });

    it('P1: validation rules >= baseline', () => {
      const m = computeMetrics();
      const pct = ((m.validationRules / m.total) * 100).toFixed(1);
      expect(m.validationRules,
        `${m.validationRules}/${m.total} (${pct}%) have validation rules — expected >= ${BASELINE_VALIDATION_RULES}`
      ).toBeGreaterThanOrEqual(BASELINE_VALIDATION_RULES);
    });

    it('P1: unknown-service count <= ceiling', () => {
      const m = computeMetrics();
      expect(m.unknownServiceCount,
        `${m.unknownServiceCount} unknown-service entries — expected <= ${CEILING_UNKNOWN_SERVICE}`
      ).toBeLessThanOrEqual(CEILING_UNKNOWN_SERVICE);
    });

    it('P2: prints quality metrics summary', () => {
      const m = computeMetrics();
      const pct = ((m.structured200 / m.total) * 100).toFixed(1);
      console.log('\n╔══════════════════════════════════════════════╗');
      console.log('║     DOCUMENT-ENDPOINT QUALITY METRICS        ║');
      console.log('╚══════════════════════════════════════════════╝');
      console.log(`  Total endpoints:             ${m.total}`);
      console.log(`  Structured 200 responses:     ${m.structured200} (${pct}%)`);
      console.log(`  Primitive 200 responses:     ${m.primitive200}`);
      console.log(`  Bare type:object:            ${m.bareObject200} (known: ${KNOWN_BARE_TYPE_OBJECT})`);
      console.log(`  GET with requestBody:        ${m.getWithRequestBody} (must be 0)`);
      console.log(`  POST/PUT missing reqBody:    ${m.postPutMissingRequestBody} (known: ${KNOWN_MISSING_REQUEST_BODY})`);
      console.log(`  items:type:string:            ${m.itemsTypeString} (known: ${KNOWN_LEGITIMATE_ITEMS_STRING})`);
      console.log(`  Downstream API docs:          ${m.downstreamApisPresent} (${((m.downstreamApisPresent / m.total) * 100).toFixed(1)}%)`);
      console.log(`  Outbound messaging:           ${m.outboundMessaging} (${((m.outboundMessaging / m.total) * 100).toFixed(1)}%)`);
      console.log(`  Validation rules:            ${m.validationRules} (${((m.validationRules / m.total) * 100).toFixed(1)}%)`);
      console.log(`  Unknown-service entries:     ${m.unknownServiceCount} (ceiling: ${CEILING_UNKNOWN_SERVICE})`);
      console.log(`  EXCHANGE method (excluded):  ${CEILING_EXCHANGE_METHOD}`);
      console.log(`  Code expression ceiling:     ${CEILING_CODE_EXPRESSION}`);
      console.log('');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // ANOMALY DETECTION TESTS
    // ═══════════════════════════════════════════════════════════════════════

    it('A2: path {param} mismatches <= ceiling (tcbsId from JWT is unfixable)', () => {
      const m = computeMetrics();
      if (m.pathParamMismatch.length > 0) {
        console.log('  Path param mismatches:');
        for (const { file, path, braces, params } of m.pathParamMismatch) {
          console.log(`    ${file}: ${path} (braces=${braces}, params=${params})`);
        }
      }
      expect(m.pathParamMismatch.length,
        `${m.pathParamMismatch.length} path param mismatches — ceiling: ${CEILING_PATH_PARAM_MISMATCH}`
      ).toBeLessThanOrEqual(CEILING_PATH_PARAM_MISMATCH);
    });

    it('A4: container without items <= ceiling', () => {
      const m = computeMetrics();
      expect(m.containerWithoutItems,
        `${m.containerWithoutItems} arrays without items — ceiling: ${CEILING_CONTAINER_WITHOUT_ITEMS}`
      ).toBeLessThanOrEqual(CEILING_CONTAINER_WITHOUT_ITEMS);
    });

    it('A5: download endpoints without octet-stream <= ceiling', () => {
      const m = computeMetrics();
      expect(m.downloadWithoutOctetStream,
        `${m.downloadWithoutOctetStream} downloads missing octet-stream — ceiling: ${CEILING_DOWNLOAD_WITHOUT_OCTET}`
      ).toBeLessThanOrEqual(CEILING_DOWNLOAD_WITHOUT_OCTET);
    });

    it('B1: unresolved downstream endpoints <= ceiling', () => {
      const m = computeMetrics();
      expect(m.unresolvedEndpoints,
        `${m.unresolvedEndpoints} unresolved endpoints (targetUrl, toString, [internal]) — ceiling: ${CEILING_UNRESOLVED_ENDPOINTS}`
      ).toBeLessThanOrEqual(CEILING_UNRESOLVED_ENDPOINTS);
    });

    it('B4: inbound topic over-inclusion <= ceiling (shared base class)', () => {
      const m = computeMetrics();
      // b.e.q.trading.005032 appears in all 341 files due to shared base class listener
      expect(m.inboundTopicAllFiles,
        `${m.inboundTopicAllFiles} files with same inbound topic — ceiling: ${CEILING_INBOUND_TOPIC_ALL_FILES}`
      ).toBeLessThanOrEqual(CEILING_INBOUND_TOPIC_ALL_FILES);
    });

    it('B7: ID path params typed as string <= ceiling', () => {
      const m = computeMetrics();
      expect(m.idPathParamString,
        `${m.idPathParamString} ID params typed as string — ceiling: ${CEILING_ID_PATH_PARAM_STRING}`
      ).toBeLessThanOrEqual(CEILING_ID_PATH_PARAM_STRING);
    });

    it('B8: endpoints without 400 response <= ceiling', () => {
      const m = computeMetrics();
      expect(m.no400Response,
        `${m.no400Response} endpoints without 400 response — ceiling: ${CEILING_NO_400_RESPONSE}`
      ).toBeLessThanOrEqual(CEILING_NO_400_RESPONSE);
    });

    it('P2: prints anomaly summary', () => {
      const m = computeMetrics();
      console.log('\n╔══════════════════════════════════════════════╗');
      console.log('║          ANOMALY DETECTION SUMMARY           ║');
      console.log('╚══════════════════════════════════════════════╝');
      console.log(`  A2 Path param mismatch:       ${m.pathParamMismatch.length} (ceiling: ${CEILING_PATH_PARAM_MISMATCH})`);
      console.log(`  A3 Bare object no props:      ${m.bareObjectNoProps}`);
      console.log(`  A4 Container without items:   ${m.containerWithoutItems} (ceiling: ${CEILING_CONTAINER_WITHOUT_ITEMS})`);
      console.log(`  A5 Download w/o octet-stream: ${m.downloadWithoutOctetStream} (ceiling: ${CEILING_DOWNLOAD_WITHOUT_OCTET})`);
      console.log(`  B1 Unresolved endpoints:       ${m.unresolvedEndpoints} (ceiling: ${CEILING_UNRESOLVED_ENDPOINTS})`);
      console.log(`  B3 Unknown-service entries:   ${m.unknownServiceCount} (ceiling: ${CEILING_UNKNOWN_SERVICE})`);
      console.log(`  B4 Inbound topic over-include:${m.inboundTopicAllFiles}/${m.total} (ceiling: ${CEILING_INBOUND_TOPIC_ALL_FILES})`);
      console.log(`  B7 ID params as string:       ${m.idPathParamString} (ceiling: ${CEILING_ID_PATH_PARAM_STRING})`);
      console.log(`  B8 No 400 response:           ${m.no400Response} (ceiling: ${CEILING_NO_400_RESPONSE})`);
      console.log('');
    });

    it('P0: no duplicate method+path combos', () => {
      const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
      const seen = new Map<string, string[]>();

      for (const file of yamlFiles) {
        const content = fs.readFileSync(path.join(tmpDir, file), 'utf8');
        const methodMatch = content.match(/^\s+(get|post|put|delete|patch):/m);
        const pathMatch = content.match(/^  (\/[^\n]+):/m);
        if (methodMatch && pathMatch) {
          const key = `${methodMatch[1].toUpperCase()} ${pathMatch[1]}`;
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key)!.push(file);
        }
      }

      const duplicates = [...seen.entries()].filter(([_, files]) => files.length > 1);
      if (duplicates.length > 0) {
        console.log('  Duplicate method+path combos:');
        for (const [key, files] of duplicates) {
          console.log(`    ${key}: ${files.join(', ')}`);
        }
      }
      expect(duplicates.length, `${duplicates.length} duplicate method+path combos — must be 0`).toBe(0);
    });
  });
});
