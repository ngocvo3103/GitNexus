/**
 * Debug: dump AST and field extraction for Go type_declaration
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabelFull, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

describe('Go handler → service field chain debug (Issue #19)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-handler-service-field'),
      () => {},
    );
  }, 60000);

  it('dump all Property nodes with full details', () => {
    const props = getNodesByLabelFull(result, 'Property');
    console.log('=== All Property nodes ===');
    for (const p of props) {
      console.log(`  ${p.name}: declaredType=${p.properties.declaredType ?? 'MISSING'}, ownerId=${p.properties.ownerId ?? 'MISSING'}, filePath=${p.properties.filePath}`);
    }
  });

  it('dump all Method nodes with full details', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    console.log('=== All Method nodes ===');
    for (const m of methods) {
      console.log(`  ${m.name}: ownerId=${m.properties.ownerId ?? 'MISSING'}, filePath=${m.properties.filePath}, returnType=${m.properties.returnType ?? 'MISSING'}`);
    }
  });

  it('dump all Struct nodes', () => {
    const structs = getNodesByLabelFull(result, 'Struct');
    console.log('=== All Struct nodes ===');
    for (const s of structs) {
      console.log(`  ${s.name}: nodeId=${s.properties.nodeId ?? 'N/A'}, filePath=${s.properties.filePath}`);
    }
  });

  it('dump all CALLS edges', () => {
    const calls = getRelationships(result, 'CALLS');
    console.log('=== All CALLS edges ===');
    for (const c of calls) {
      console.log(`  ${c.source}(${c.sourceLabel}@${c.sourceFilePath}) -> ${c.target}(${c.targetLabel}@${c.targetFilePath})`);
    }
  });

  it('dump all HAS_PROPERTY edges', () => {
    const hasProp = getRelationships(result, 'HAS_PROPERTY');
    console.log('=== All HAS_PROPERTY edges ===');
    for (const c of hasProp) {
      console.log(`  ${c.source}(${c.sourceLabel}) -> ${c.target}(${c.targetLabel})`);
    }
  });
});