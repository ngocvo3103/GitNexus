import path from 'path';

const __dirname = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const fixture = path.resolve(__dirname, '..', 'test', 'fixtures', 'lang-resolution', 'go-pkg');

console.log('inspect_extends script starting');

(async () => {
  try {
    console.log('Importing pipeline...');
    const pipelineMod = await import('../dist/core/ingestion/pipeline.js');
    const { runPipelineFromRepo } = pipelineMod;
    console.log('Pipeline imported:', typeof runPipelineFromRepo === 'function');

    console.log('Running pipeline against fixture:', fixture);
    const result = await runPipelineFromRepo(fixture, () => {});

    if (!result || !result.graph) {
      console.error('Pipeline returned no result or missing graph');
      process.exit(2);
    }

    const extendsEdges = [];
    const callsEdges = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'EXTENDS') {
        const s = result.graph.getNode(rel.sourceId);
        const t = result.graph.getNode(rel.targetId);
        extendsEdges.push({ id: rel.id, sourceId: rel.sourceId, targetId: rel.targetId, source: s?.properties.name, target: t?.properties.name, sourceFile: s?.properties.filePath, targetFile: t?.properties.filePath });
      }
      if (rel.type === 'CALLS') {
        const s = result.graph.getNode(rel.sourceId);
        const t = result.graph.getNode(rel.targetId);
        const srcName = s?.properties.name ?? rel.sourceId;
        const tgtName = t?.properties.name ?? rel.targetId;
        if (srcName === 'processUsers' || srcName === 'processRepos' || tgtName === 'Save') {
          callsEdges.push({ id: rel.id, type: rel.type, source: srcName, target: tgtName, sourceFile: s?.properties.filePath, targetFile: t?.properties.filePath, rel });
        }
      }
    }

    console.log('\nEXTENDS edges (' + extendsEdges.length + '):');
    for (const e of extendsEdges) {
      console.log(JSON.stringify(e));
    }

    console.log('\nRelevant CALLS edges:');
    for (const c of callsEdges) console.log(JSON.stringify(c));

    // Also print all Struct nodes to see duplicates
    const structs = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push({ id: n.id, name: n.properties.name, file: n.properties.filePath });
    });
    console.log('\nStruct nodes (' + structs.length + '):');
    for (const s of structs) console.log(JSON.stringify(s));

    // Print all EXTENDS relationship raw ids and reasons too
    const rawExt = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'EXTENDS') rawExt.push({ id: rel.id, sourceId: rel.sourceId, targetId: rel.targetId, reason: rel.reason, confidence: rel.confidence });
    }
    console.log('\nRaw EXTENDS:', JSON.stringify(rawExt, null, 2));

    process.exit(0);
  } catch (err) {
    console.error('Script error:', err);
    if (err && err.stack) console.error(err.stack);
    process.exit(3);
  }
})();
