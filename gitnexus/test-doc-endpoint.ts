/**
 * Direct test for document-endpoint function using LocalBackend
 */
import { LocalBackend } from './src/mcp/local/local-backend.js';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = '/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/tmp';
const METHOD = 'PUT';
const PATH = '/e/v1/bookings/{productCode}/suggest';
const REPO = 'tcbs-bond-trading';

async function main() {
  console.log('Starting document-endpoint tests...');
  
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const testResults = [];

  try {
    // Create LocalBackend and resolve repo
    console.log(`Loading repo: ${REPO}`);
    const backend = new LocalBackend();
    await backend.refreshRepos();
    const repo = await backend.resolveRepo(REPO);
    console.log(`Repo resolved: ${repo.name} (${repo.id})`);

    // Test 1: No context
    console.log('\n=== Test 1: No context ===');
    const noContextResult = await backend.documentEndpoint(repo, {
      method: METHOD,
      path: PATH,
      depth: 10,
      include_context: false,
    });
    const noContextFile = path.join(OUTPUT_DIR, 'endpoint-no-context.json');
    fs.writeFileSync(noContextFile, JSON.stringify(noContextResult, null, 2));
    console.log(`Written: ${noContextFile} (${(fs.statSync(noContextFile).size / 1024).toFixed(2)} KB)`);
    testResults.push({ name: 'No context', file: noContextFile, size: fs.statSync(noContextFile).size });

    // Test 2: With context
    console.log('\n=== Test 2: With context ===');
    const withContextResult = await backend.documentEndpoint(repo, {
      method: METHOD,
      path: PATH,
      depth: 10,
      include_context: true,
    });
    const withContextFile = path.join(OUTPUT_DIR, 'endpoint-with-context.json');
    fs.writeFileSync(withContextFile, JSON.stringify(withContextResult, null, 2));
    console.log(`Written: ${withContextFile} (${(fs.statSync(withContextFile).size / 1024).toFixed(2)} KB)`);
    testResults.push({ name: 'With context', file: withContextFile, size: fs.statSync(withContextFile).size });

    // Summary
    console.log('\n=== Test Summary ===');
    for (const result of testResults) {
      console.log(`${result.name}: ${result.file} (${(result.size / 1024).toFixed(2)} KB)`);
    }

    // Validation check
    console.log('\n=== Validation Check ===');
    const result = noContextResult.result || noContextResult;
    
    if (result.externalApis && result.externalApis.length > 0) {
      console.log(`✓ External APIs found: ${result.externalApis.length}`);
      for (const api of result.externalApis.slice(0, 5)) {
        console.log(`  - ${api.serviceName || api.endpoint}`);
      }
    } else {
      console.log('✗ No external APIs found');
    }
    
    if (result.messaging && result.messaging.length > 0) {
      console.log(`✓ Messaging found: ${result.messaging.length}`);
      for (const msg of result.messaging.slice(0, 3)) {
        console.log(`  - ${msg.topic || msg.name}`);
      }
    } else {
      console.log('✗ No messaging found');
    }

    // Check for validation field
    if (result.validation) {
      console.log(`✓ Validation found`);
      if (result.validation.request) console.log(`  - Request validation: ${result.validation.request.length} rules`);
      if (result.validation.response) console.log(`  - Response validation: ${result.validation.response.length} rules`);
    } else {
      console.log('✗ No validation field');
    }

    // Check for dependencies
    if (result.dependencies) {
      console.log(`✓ Dependencies found`);
      console.log(`  - Database: ${result.dependencies.database?.length || 0}`);
      console.log(`  - Services: ${result.dependencies.services?.length || 0}`);
    } else {
      console.log('✗ No dependencies field');
    }

    // Check for handler info
    if (result.handlerMethod || result.handlerClass) {
      console.log(`✓ Handler found: ${result.handlerClass}#${result.handlerMethod}`);
    } else {
      console.log('✗ No handler found');
    }

  } catch (error) {
    console.error('Error:', error);
    
    // Write error to bug file
    const bugFile = '/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/bug/document-endpoint-test-failure.md';
    const errorContent = `# Document-Endpoint Test Failure

**Date:** ${new Date().toISOString()}

## Error

\`\`\`
${error.stack || error.message || error}
\`\`\`

## Test Parameters

- Method: ${METHOD}
- Path: ${PATH}
- Repo: ${REPO}

## Environment

- Node version: ${process.version}
- Working directory: ${process.cwd()}
`;
    fs.mkdirSync(path.dirname(bugFile), { recursive: true });
    fs.writeFileSync(bugFile, errorContent);
    console.log(`Error written to: ${bugFile}`);
    process.exit(1);
  }
}

main().catch(console.error);
