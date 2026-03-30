import type { ExtractedRoute } from './parse-worker.js';
import type Parser from 'tree-sitter';

/**
 * Extracts HTTP routes from Spring Boot controller classes by analyzing
 * tree-sitter AST for Java annotations like @GetMapping, @PostMapping, etc.
 *
 * Key behaviors:
 * - Skips @FeignClient interfaces/classes entirely
 * - Combines class-level @RequestMapping prefix with method-level paths
 * - Sets isControllerClass=true for classes with @RestController/@Controller
 * - Defaults to GET for @RequestMapping without method attribute
 */

// Tree-sitter Java node types for annotations
// - marker_annotation — no args (e.g., @RestController, @GetMapping with no path)
// - annotation + annotation_argument_list → element_value_pair nodes

const HTTP_METHOD_ANNOTATIONS = new Map<string, string>([
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
]);

/**
 * Combines class prefix with method path, normalizing the result.
 * - Strips trailing slashes from prefix
 * - Ensures method path starts with /
 * - Avoids double slashes
 */
function combinePaths(prefix: string | null, methodPath: string): string {
  if (!prefix && !methodPath) return '';
  if (!prefix) return methodPath.startsWith('/') ? methodPath : '/' + methodPath;
  if (!methodPath) return prefix;

  // Strip trailing slash from prefix
  const p = prefix.replace(/\/+$/, '');
  // Ensure method path starts with /
  const m = methodPath.startsWith('/') ? methodPath : '/' + methodPath;
  return p + m;
}

/**
 * Extracts string content from a string_literal node.
 */
function extractStringContent(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type !== 'string_literal') return null;
  // string_literal has string_fragment as a child with the actual content
  for (const child of node.children) {
    if (child.type === 'string_fragment') {
      return child.text;
    }
  }
  // Fallback: remove quotes from the text
  return node.text.replace(/^["']|["']$/g, '');
}

/**
 * Extracts the first string argument from an annotation.
 * Handles both unnamed first arg and named "value" or "path" attributes.
 */
function extractAnnotationPath(annotationNode: Parser.SyntaxNode): string | null {
  // marker_annotation has no arguments
  if (annotationNode.type === 'marker_annotation') {
    return '';
  }

  // annotation has annotation_argument_list
  const argsList = annotationNode.childForFieldName('arguments') ?? annotationNode.children.find(c => c.type === 'annotation_argument_list');
  if (!argsList) return null;

  // Look for element_value_pair with key "value" or "path"
  for (const child of argsList.children) {
    if (child.type === 'element_value_pair') {
      // The key is an 'identifier' child, not 'key' field
      const keyNode = child.children.find(c => c.type === 'identifier');
      if (keyNode && (keyNode.text === 'value' || keyNode.text === 'path')) {
        // Find string_literal among children (after the '=')
        const strNode = child.children.find(c => c.type === 'string_literal');
        if (strNode) {
          const str = extractStringContent(strNode);
          if (str !== null) return str;
        }
      }
    }
  }

  // Look for unnamed first string_literal (e.g., @GetMapping("/users"))
  for (const child of argsList.children) {
    if (child.type === 'string_literal') {
      return extractStringContent(child);
    }
  }

  return null;
}

/**
 * Extracts HTTP method from @RequestMapping annotation.
 * Returns GET by default if no method attribute.
 * Handles:
 *   - method = RequestMethod.POST
 *   - method = {RequestMethod.PUT} (array syntax)
 */
function extractRequestMappingMethod(annotationNode: Parser.SyntaxNode): string {
  if (annotationNode.type === 'marker_annotation') {
    return 'GET'; // Default method
  }

  const argsList = annotationNode.childForFieldName('arguments') ?? annotationNode.children.find(c => c.type === 'annotation_argument_list');
  if (!argsList) return 'GET';

  for (const child of argsList.children) {
    if (child.type === 'element_value_pair') {
      // The key is an 'identifier' child
      const keyNode = child.children.find(c => c.type === 'identifier');
      if (keyNode && keyNode.text === 'method') {
        // Find value after '=' (could be field_access or element_value_array_initializer)
        const valueNode = child.children.find(c => c.type === 'field_access' || c.type === 'scoped_identifier' || c.type === 'element_value_array_initializer');
        if (valueNode) {
          // Handle: method = RequestMethod.POST
          if (valueNode.type === 'field_access' || valueNode.type === 'scoped_identifier') {
            const parts = valueNode.text.split('.');
            const lastPart = parts[parts.length - 1];
            return lastPart.toUpperCase();
          }
          // Handle: method = {RequestMethod.PUT} (element_value_array_initializer)
          if (valueNode.type === 'element_value_array_initializer') {
            for (const elem of valueNode.children) {
              if (elem.type === 'field_access' || elem.type === 'scoped_identifier') {
                const parts = elem.text.split('.');
                const lastPart = parts[parts.length - 1];
                return lastPart.toUpperCase();
              }
            }
          }
        }
      }
    }
  }

  return 'GET'; // Default
}

/**
 * Checks if a class/interface has a specific annotation.
 */
function hasAnnotation(classBody: Parser.SyntaxNode | null, annotationName: string): boolean {
  if (!classBody) return false;

  // Find the class_declaration or interface_declaration node
  const classDecl = classBody.parent;
  if (!classDecl) return false;

  // Look for modifiers which contain annotations
  for (const child of classDecl.children) {
    if (child.type === 'modifiers' || child.type === 'marker_annotation' || child.type === 'annotation') {
      // Check for annotation in modifiers
      const annotations = child.type === 'modifiers' ? child.children : [child];
      for (const ann of annotations) {
        if (ann.type === 'marker_annotation' || ann.type === 'annotation') {
          const nameNode = ann.childForFieldName('name') ?? ann.children[0];
          if (nameNode && nameNode.text === annotationName) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Gets all annotations from a class or interface declaration.
 */
function getClassAnnotations(classDecl: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const annotations: Parser.SyntaxNode[] = [];

  for (const child of classDecl.children) {
    if (child.type === 'modifiers') {
      for (const modChild of child.children) {
        if (modChild.type === 'marker_annotation' || modChild.type === 'annotation') {
          annotations.push(modChild);
        }
      }
    } else if (child.type === 'marker_annotation' || child.type === 'annotation') {
      annotations.push(child);
    }
  }

  return annotations;
}

/**
 * Extracts the path from a class-level @RequestMapping annotation.
 */
function getClassRequestMappingPrefix(classDecl: Parser.SyntaxNode): string | null {
  const annotations = getClassAnnotations(classDecl);

  for (const ann of annotations) {
    // The annotation name is an 'identifier' child, not 'name' field
    const nameNode = ann.children.find(c => c.type === 'identifier');
    if (nameNode && nameNode.text === 'RequestMapping') {
      return extractAnnotationPath(ann);
    }
  }

  return null;
}

/**
 * Extracts the method name from a method_declaration node.
 */
function getMethodName(methodDecl: Parser.SyntaxNode): string | null {
  for (const child of methodDecl.children) {
    if (child.type === 'identifier' || child.type === 'method_header') {
      // For method_header, find the identifier inside
      if (child.type === 'method_header') {
        for (const headerChild of child.children) {
          if (headerChild.type === 'identifier') {
            return headerChild.text;
          }
        }
      } else {
        return child.text;
      }
    }
  }
  // Fallback: look for method_header and then identifier
  const header = methodDecl.childForFieldName('name') ?? methodDecl.children.find(c => c.type === 'identifier');
  return header ? header.text : null;
}

/**
 * Extracts routes from a single class/interface declaration.
 */
function extractRoutesFromClass(
  classDecl: Parser.SyntaxNode,
  filePath: string,
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  // Check for @FeignClient — skip entire class/interface
  const classAnnotations = getClassAnnotations(classDecl);
  for (const ann of classAnnotations) {
    // The annotation name is an 'identifier' child, not 'name' field
    const nameNode = ann.children.find(c => c.type === 'identifier');
    if (nameNode && nameNode.text === 'FeignClient') {
      return []; // Skip FeignClient
    }
  }

  // Check if this is a controller class
  const isControllerClass = classAnnotations.some(ann => {
    const nameNode = ann.children.find(c => c.type === 'identifier');
    return nameNode && (nameNode.text === 'RestController' || nameNode.text === 'Controller');
  });

  // Get class-level @RequestMapping prefix
  const classPrefix = getClassRequestMappingPrefix(classDecl);

  // Get class name
  const className = classDecl.childForFieldName('name')?.text ?? classDecl.children.find(c => c.type === 'identifier')?.text;

  // Find class_body
  const classBody = classDecl.children.find(c => c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body');

  if (!classBody) return [];

  // Iterate over methods in class_body
  for (const member of classBody.children) {
    if (member.type !== 'method_declaration') continue;

    const methodName = getMethodName(member);
    if (!methodName) continue;

    // Find route annotations on the method
    for (const child of member.children) {
      if (child.type === 'modifiers') {
        for (const modChild of child.children) {
          if (modChild.type === 'marker_annotation' || modChild.type === 'annotation') {
            const ann = modChild;
            // The annotation name is an 'identifier' child
            const nameNode = ann.children.find(c => c.type === 'identifier');
            if (!nameNode) continue;

            const annotationName = nameNode.text;

            // Check for specific HTTP method annotations
            if (HTTP_METHOD_ANNOTATIONS.has(annotationName)) {
              const methodPath = extractAnnotationPath(ann) ?? '';
              const fullRoutePath = combinePaths(classPrefix, methodPath);
              const lineNumber = ann.startPosition.row + 1; // tree-sitter uses 0-based

              routes.push({
                filePath,
                httpMethod: HTTP_METHOD_ANNOTATIONS.get(annotationName)!,
                routePath: fullRoutePath,
                controllerName: className ?? null,
                methodName,
                middleware: [],
                prefix: classPrefix,
                lineNumber,
                isControllerClass,
              });
            } else if (annotationName === 'RequestMapping') {
              const methodPath = extractAnnotationPath(ann) ?? '';
              const httpMethod = extractRequestMappingMethod(ann);
              const fullRoutePath = combinePaths(classPrefix, methodPath);
              const lineNumber = ann.startPosition.row + 1;

              routes.push({
                filePath,
                httpMethod,
                routePath: fullRoutePath,
                controllerName: className ?? null,
                methodName,
                middleware: [],
                prefix: classPrefix,
                lineNumber,
                isControllerClass,
              });
            }
          }
        }
      }
    }
  }

  return routes;
}

/**
 * Main entry point: extracts Spring routes from a parsed Java file.
 * Walks all class and interface declarations, extracts routes from controller classes.
 */
export function extractSpringRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function walk(node: Parser.SyntaxNode): void {
    // Check for class_declaration, interface_declaration, enum_declaration
    if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
      const classRoutes = extractRoutesFromClass(node, filePath);
      routes.push(...classRoutes);
      // Continue walking for nested classes
    }

    // Recurse into children
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return routes;
}