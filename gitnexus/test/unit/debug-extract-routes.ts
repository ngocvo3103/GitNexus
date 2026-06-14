import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const springModule = await import(pathToFileURL(join(__dirname, '../../src/core/ingestion/route-extractors/spring.ts')).href);
  const extractSpringRoutes = springModule.extractSpringRoutes;
  const javaSource = readFileSync(join(__dirname, '../../src/core/ingestion/route-extractors/AuthController.java'), 'utf8');
  // In ra AST root
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(javaSource);
  const root = tree.rootNode;
  console.log('Root children types:', root.namedChildren.map((n) => n.type));
  // Tìm class_declaration đầu tiên
  const classNode = root.namedChildren.find((n) => n.type === 'class_declaration');
  if (classNode) {
    console.log('class_declaration children types:', classNode.namedChildren.map((n) => n.type));
    classNode.namedChildren.forEach((n, i) => {
      console.log(`Child[${i}]: type=${n.type}, text=${n.text.slice(0, 40)}`);
    });
  }
  // Gọi extractSpringRoutes như cũ
  const routes = await extractSpringRoutes(javaSource);
  console.log('Extracted routes:', JSON.stringify(routes, null, 2));
}

main();
