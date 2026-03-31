import path from 'path';

const __dirname = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const fixture = path.resolve(__dirname, '..', 'test', 'fixtures', 'lang-resolution', 'go-for-call-expr');

async function main(){
  try{
    console.log('Importing pipeline...');
    const pipeline = await import('../dist/core/ingestion/pipeline.js');
    const { runPipelineFromRepo } = pipeline;
    console.log('Running pipeline on', fixture);
    const result = await runPipelineFromRepo(fixture, () => {});
    if(!result || !result.graph){
      console.error('No graph result');
      process.exit(2);
    }
    const calls = [];
    for(const rel of result.graph.iterRelationships()){
      if(rel.type === 'CALLS'){
        const s = result.graph.getNode(rel.sourceId);
        const t = result.graph.getNode(rel.targetId);
        calls.push({source: s?.properties.name ?? rel.sourceId, sourceFile: s?.properties.filePath, target: t?.properties.name ?? rel.targetId, targetFile: t?.properties.filePath, rel});
      }
    }
    console.log('\nCALLS ('+calls.length+')');
    for(const c of calls) console.log(JSON.stringify(c));

    const funcs = [];
    result.graph.forEachNode(n => { if(n.label === 'Function') funcs.push({name: n.properties.name, file: n.properties.filePath}); });
    console.log('\nFUNCTIONS ('+funcs.length+')');
    for(const f of funcs) console.log(JSON.stringify(f));

    process.exit(0);
  }catch(e){
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(3);
  }
}

main();

