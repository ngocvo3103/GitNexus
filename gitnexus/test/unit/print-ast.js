import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const javaSource = readFileSync(join(__dirname, '../../src/core/ingestion/route-extractors/AuthController.java'), 'utf8');
const parser = new Parser();
parser.setLanguage(Java);
const tree = parser.parse(javaSource);
console.log(JSON.stringify(tree.rootNode.toJSON(), null, 2));
