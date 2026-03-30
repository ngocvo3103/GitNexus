// Extracts Spring Boot routes from Java source code
// This is a basic implementation using regex for annotation parsing
// For robust extraction, consider integrating a Java parser in the future
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

export interface SpringRoute {
  path: string;
  method: string;
  httpMethod?: string; // optional for compatibility
  controller: string;
  handler: string;
  lineNumber: number;
  framework: string;
}

const CONTROLLER_ANNOTATIONS = [
  '@RestController',
  '@Controller',
];

const MAPPING_ANNOTATIONS = [
  { regex: /@GetMapping\(([^)]*)\)/, method: 'GET' },
  { regex: /@PostMapping\(([^)]*)\)/, method: 'POST' },
  { regex: /@PutMapping\(([^)]*)\)/, method: 'PUT' },
  { regex: /@DeleteMapping\(([^)]*)\)/, method: 'DELETE' },
  { regex: /@RequestMapping\(([^)]*)\)/, method: 'ANY' },
];

function joinSpringPaths(classPath: string, methodPath: string): string {
  // Normalize both paths
  let c = classPath ? classPath.trim() : '';
  let m = methodPath ? methodPath.trim() : '';
  if (!c && !m) return '/';
  // Remove trailing slash from classPath (unless it's just '/')
  if (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1);
  // Remove leading slash from methodPath
  if (m.startsWith('/')) m = m.slice(1);
  // Avoid double slashes
  if (c && m) return (c.startsWith('/') ? '' : '/') + c + (m ? '/' + m : '');
  if (c) return c.startsWith('/') ? c : '/' + c;
  if (m) return m.startsWith('/') ? m : '/' + m;
  return '/';
}

export async function extractSpringRoutes(javaSource: string): Promise<SpringRoute[]> {
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(javaSource);
  const routes: SpringRoute[] = [];

  function getAnnotationName(annotationNode: any): string | null {
    if (!annotationNode) return null;
    // For marker_annotation or annotation
    const idNode = annotationNode.namedChildren?.find((n: any) => n.type === 'identifier');
    return idNode ? idNode.text : null;
  }

  function getAnnotationValue(annotationNode: any, key: string | null = null): string | null {
    if (!annotationNode) return null;
    // For annotation arguments
    const argsNode = annotationNode.namedChildren?.find((n: any) => n.type === 'argument_list' || n.type === 'annotation_argument_list');
    if (!argsNode) return null;
    if (key) {
      // Find key-value pair
      for (const pair of argsNode.namedChildren) {
        if (pair.type === 'element_value_pair' && pair.namedChildren[0]?.text === key) {
          const valNode = pair.namedChildren[1];
          if (valNode && valNode.type === 'string_literal') {
            return valNode.text.replace(/['"]/g, '');
          }
        }
      }
    } else {
      // Single value or multiple values
      for (const valNode of argsNode.namedChildren) {
        if (valNode.type === 'string_literal') {
          return valNode.text.replace(/['"]/g, '');
        }
        // Handle array_initializer for multiple paths (take the first one)
        if (valNode.type === 'array_initializer' && valNode.namedChildren.length > 0) {
          const first = valNode.namedChildren.find((n: any) => n.type === 'string_literal');
          if (first) return first.text.replace(/['"]/g, '');
        }
      }
    }
    return null;
  }

  function getModifiers(node: any) {
    // Chỉ lấy annotation từ modifiers node
    const modifiersNode = node.namedChildren?.find((n: any) => n.type === 'modifiers');
    if (!modifiersNode) return [];
    return modifiersNode.namedChildren?.filter((n: any) => n.type.endsWith('annotation')) || [];
  }

  function findNodesByType(node: any, type: string, results: any[] = []) {
    if (node.type === type) results.push(node);
    if (node.namedChildren) {
      for (const child of node.namedChildren) {
        findNodesByType(child, type, results);
      }
    }
    return results;
  }

  function findControllerClasses(root: any) {
    const result: any[] = [];
    const classNodes = findNodesByType(root, 'class_declaration');
    for (const classNode of classNodes) {
      const annotations = getModifiers(classNode);
      for (const ann of annotations) {
        const annName = getAnnotationName(ann);
        if (CONTROLLER_ANNOTATIONS.includes('@' + annName)) {
          result.push(classNode);
          break;
        }
      }
    }
    return result;
  }

  function extractRoutesFromClass(classNode: any) {
    let classLevelPath = '';
    let controllerName = classNode.namedChildren.find((n: any) => n.type === 'identifier')?.text || '';
    const classAnnotations = getModifiers(classNode);
    for (const ann of classAnnotations) {
      const annName = getAnnotationName(ann);
      if (annName === 'RequestMapping') {
        classLevelPath = getAnnotationValue(ann, 'value') || getAnnotationValue(ann, 'path') || getAnnotationValue(ann) || '';
      }
    }
    const classBody = classNode.namedChildren.find((n: any) => n.type === 'class_body');
    if (!classBody) return;
    for (const methodNode of classBody.namedChildren.filter((n: any) => n.type === 'method_declaration')) {
      let methodLevelPath = '';
      let httpMethods: string[] = ['ANY'];
      let handler = methodNode.namedChildren.find((n: any) => n.type === 'identifier')?.text || '';
      const methodAnnotations = getModifiers(methodNode);
      for (const ann of methodAnnotations) {
        const annName = getAnnotationName(ann);
        if (annName === 'GetMapping') { httpMethods = ['GET']; }
        if (annName === 'PostMapping') { httpMethods = ['POST']; }
        if (annName === 'PutMapping') { httpMethods = ['PUT']; }
        if (annName === 'DeleteMapping') { httpMethods = ['DELETE']; }
        if ([
          'GetMapping','PostMapping','PutMapping','DeleteMapping','RequestMapping'
        ].includes(annName)) {
          methodLevelPath = getAnnotationValue(ann, 'value') || getAnnotationValue(ann, 'path') || getAnnotationValue(ann) || '';
          if (methodLevelPath.startsWith('/')) methodLevelPath = methodLevelPath.slice(1);
          if (annName === 'RequestMapping') {
            const argsNode = ann.namedChildren?.find((n: any) => n.type === 'argument_list' || n.type === 'annotation_argument_list');
            if (argsNode) {
              for (const pair of argsNode.namedChildren) {
                if (pair.type === 'element_value_pair' && pair.namedChildren[0]?.text === 'method') {
                  const valNode = pair.namedChildren[1];
                  if (valNode) {
                    if (valNode.type === 'field_access') {
                      const val = valNode.text;
                      if (val && val.startsWith('RequestMethod.')) {
                        httpMethods = [val.replace('RequestMethod.', '')];
                      }
                    } else if (valNode.type === 'array_initializer') {
                      httpMethods = valNode.namedChildren
                        .filter((n: any) => n.type === 'field_access' && n.text.startsWith('RequestMethod.'))
                        .map((n: any) => n.text.replace('RequestMethod.', ''));
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (methodLevelPath || classLevelPath) {
        const fullPath = joinSpringPaths(classLevelPath, methodLevelPath);
        for (const httpMethod of httpMethods) {
          routes.push({
            path: fullPath,
            method: httpMethod,
            controller: controllerName,
            handler,
            lineNumber: methodNode.startPosition?.row ?? 0,
            framework: 'spring',
          });
        }
      }
    }
  }

  const controllerClasses = findControllerClasses(tree.rootNode);
  for (const cls of controllerClasses) {
    extractRoutesFromClass(cls);
  }
  return routes;
}
