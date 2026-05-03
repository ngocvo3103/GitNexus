/**
 * Config/Property File Indexer
 * 
 * Parses application*.properties and application*.yml/yaml files
 * and creates Property nodes in the knowledge graph.
 * 
 * Supports:
 * - Spring Boot application.properties (key=value format)
 * - Spring Boot application.yml/yaml (nested YAML format)
 * - Profile extraction from filename (e.g., application-dev.yml → profile: 'dev')
 */

import { GraphNode } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

// ============================================================================
// Types
// ============================================================================

export interface PropertyData {
  /** The property key (e.g., 'spring.datasource.url') */
  key: string;
  /** The property value */
  value: string;
  /** Profile extracted from filename (e.g., 'dev' from application-dev.yml) */
  profile?: string;
  /** Source file path */
  filePath: string;
  /** Line number in source file */
  line: number;
}

export interface ConfigIndexResult {
  properties: PropertyData[];
  filePath: string;
  profile?: string;
}

// ============================================================================
// File Pattern Detection
// ============================================================================

/**
 * Regex patterns for matching application config files
 */
const CONFIG_FILE_PATTERNS = [
  /^application\.properties$/i,
  /^application-([a-zA-Z0-9_-]+)\.properties$/i,
  /^application\.yml$/i,
  /^application\.yaml$/i,
  /^application-([a-zA-Z0-9_-]+)\.yml$/i,
  /^application-([a-zA-Z0-9_-]+)\.yaml$/i,
];

/**
 * Check if a file path matches application config patterns
 */
export function isConfigFile(filePath: string): boolean {
  const filename = filePath.split('/').pop() || '';
  return CONFIG_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

/**
 * Extract profile from config filename
 * Examples:
 * - 'application.properties' → undefined
 * - 'application-dev.yml' → 'dev'
 * - 'application-test.properties' → 'test'
 */
export function extractProfile(filePath: string): string | undefined {
  const filename = filePath.split('/').pop() || '';
  
  // Match application-{profile}.properties or application-{profile}.yml
  const profileMatch = filename.match(/^application-([a-zA-Z0-9_-]+)\.(properties|ya?ml)$/i);
  
  if (profileMatch) {
    return profileMatch[1];
  }
  
  return undefined;
}

/**
 * Get all config files from a list of file paths
 */
export function filterConfigFiles(filePaths: string[]): string[] {
  return filePaths.filter(isConfigFile);
}

// ============================================================================
// Properties File Parser
// ============================================================================

/**
 * Parse Java/Spring properties file content
 * Handles:
 * - key=value pairs
 * - key:value pairs (alternative syntax)
 * - Comments (lines starting with # or !)
 * - Multi-line values (backslash continuation)
 * - Empty lines
 */
export function parsePropertiesFile(content: string, filePath: string): PropertyData[] {
  const properties: PropertyData[] = [];
  const profile = extractProfile(filePath);
  const lines = content.split('\n');
  
  let currentKey: string | null = null;
  let currentValue: string | null = null;
  let startLine = 0;
  
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum];
    const line = rawLine.trim();
    
    // Skip empty lines
    if (line === '') {
      continue;
    }
    
    // Skip comments
    if (line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    
    // Handle line continuation (backslash at end)
    const hasContinuation = rawLine.endsWith('\\');
    
    if (currentKey === null) {
      // Start of a new property
      // Try key=value first, then key:value
      const equalIndex = line.indexOf('=');
      const colonIndex = line.indexOf(':');
      
      let separatorIndex = -1;
      if (equalIndex !== -1 && colonIndex !== -1) {
        separatorIndex = Math.min(equalIndex, colonIndex);
      } else if (equalIndex !== -1) {
        separatorIndex = equalIndex;
      } else if (colonIndex !== -1) {
        separatorIndex = colonIndex;
      }
      
      if (separatorIndex > 0) {
        currentKey = line.substring(0, separatorIndex).trim();
        currentValue = line.substring(separatorIndex + 1).trim();
        startLine = lineNum;
        
        // Handle backslash continuation
        if (hasContinuation && currentValue.endsWith('\\')) {
          currentValue = currentValue.slice(0, -1);
        } else if (!hasContinuation) {
          // Single-line property
          properties.push({
            key: currentKey,
            value: currentValue,
            profile,
            filePath,
            line: startLine + 1, // 1-indexed
          });
          currentKey = null;
          currentValue = null;
        }
      }
    } else {
      // Continuation of previous property
      let continuationValue = line;
      if (hasContinuation && continuationValue.endsWith('\\')) {
        continuationValue = continuationValue.slice(0, -1);
        currentValue = (currentValue || '') + continuationValue;
      } else {
        currentValue = (currentValue || '') + continuationValue;
        properties.push({
          key: currentKey,
          value: currentValue.trim(),
          profile,
          filePath,
          line: startLine + 1, // 1-indexed
        });
        currentKey = null;
        currentValue = null;
      }
    }
  }
  
  // Handle property that ended without newline
  if (currentKey !== null && currentValue !== null) {
    properties.push({
      key: currentKey,
      value: currentValue.trim(),
      profile,
      filePath,
      line: startLine + 1,
    });
  }
  
  return properties;
}

// ============================================================================
// YAML File Parser
// ============================================================================

/**
 * Parse YAML content and flatten nested keys to dotted paths
 * 
 * Examples:
 * - spring:
 *     datasource:
 *       url: jdbc:mysql://localhost
 *   → {key: 'spring.datasource.url', value: 'jdbc:mysql://localhost'}
 * 
 * - server:
 *     port: 8080
 *   → {key: 'server.port', value: '8080'}
 */
export function parseYamlFile(content: string, filePath: string): PropertyData[] {
  const properties: PropertyData[] = [];
  const profile = extractProfile(filePath);
  const lines = content.split('\n');
  
  // Track current path (stack of keys with their indent levels)
  const pathStack: Array<{ key: string; indent: number }> = [];
  
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum];
    
    // Skip empty lines
    if (rawLine.trim() === '') {
      continue;
    }
    
    // Skip comments (YAML comments start with #)
    if (rawLine.trim().startsWith('#')) {
      continue;
    }
    
    // Skip YAML directives and document markers
    if (rawLine.trim().startsWith('---') || rawLine.trim().startsWith('%')) {
      continue;
    }
    
    // Calculate indentation
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmedLine = rawLine.trim();
    
    // Skip list items (lines starting with -)
    if (trimmedLine.startsWith('- ')) {
      continue;
    }
    
    // Parse key: value
    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    
    const key = trimmedLine.substring(0, colonIndex).trim();
    const rawValue = trimmedLine.substring(colonIndex + 1).trim();
    
    // Pop stack to find parent at this indent level
    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      pathStack.pop();
    }
    
    // Build full path
    const path = pathStack.length > 0
      ? [...pathStack.map(item => item.key), key].join('.')
      : key;
    
    // Determine if this is a leaf node (has a non-empty value) or a parent node
    // A leaf has content after the colon that is NOT just whitespace
    const isLeaf = rawValue.length > 0;
    
    if (isLeaf) {
      // This is a leaf with a value - extract it
      let value = rawValue;
      
      // Unquote strings
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // Handle special YAML values
      if (value === '~' || value.toLowerCase() === 'null') {
        value = '';
      }
      
      properties.push({
        key: path,
        value: unescapeYamlValue(value),
        profile,
        filePath,
        line: lineNum + 1, // 1-indexed
      });
    } else {
      // This is a parent node (no value after colon), push to stack for nested keys
      pathStack.push({ key, indent });
    }
  }
  
  return properties;
}

/**
 * Unescape common YAML escape sequences
 */
function unescapeYamlValue(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

// ============================================================================
// Property Node Creation
// ============================================================================

/**
 * Convert PropertyData to GraphNode
 */
export function propertyToGraphNode(prop: PropertyData): GraphNode {
  // Property nodes use CODE_ELEMENT_BASE schema which includes content and description
  return {
    id: generateId('Property', `${prop.filePath}:${prop.key}`),
    label: 'Property',
    properties: {
      name: prop.key,
      filePath: prop.filePath,
      startLine: prop.line,
      endLine: prop.line,
      content: prop.value,
      description: prop.profile,
    } as any,  // content not in NodeProperties but in Property schema
  };
}

/**
 * Create CONTAINS relationships from File node to Property nodes
 */
export function createPropertyRelationships(
  filePath: string,
  propertyNodes: GraphNode[]
): Array<{ id: string; type: 'CONTAINS'; sourceId: string; targetId: string; confidence: number; reason: string }> {
  const fileId = generateId('File', filePath);
  
  return propertyNodes.map(node => ({
    id: generateId('CONTAINS', `${fileId}->${node.id}`),
    type: 'CONTAINS' as const,
    sourceId: fileId,
    targetId: node.id,
    confidence: 1.0,
    reason: 'config-property',
  }));
}

// ============================================================================
// Main Indexer Function
// ============================================================================

/**
 * Index a single config file and extract properties
 */
export function indexConfigFile(
  content: string,
  filePath: string
): ConfigIndexResult {
  const isYaml = /\.(ya?ml)$/i.test(filePath);
  const profile = extractProfile(filePath);
  
  const properties = isYaml
    ? parseYamlFile(content, filePath)
    : parsePropertiesFile(content, filePath);
  
  return {
    properties,
    filePath,
    profile,
  };
}

/**
 * Index multiple config files
 * 
 * @param files - Array of {path, content} objects
 * @returns Array of PropertyData from all files
 */
export function indexConfigFiles(
  files: Array<{ path: string; content: string }>
): PropertyData[] {
  const allProperties: PropertyData[] = [];
  
  for (const { path, content } of files) {
    if (!isConfigFile(path)) {
      continue;
    }
    
    const result = indexConfigFile(content, path);
    allProperties.push(...result.properties);
  }
  
  return allProperties;
}

/**
 * Process config files and add Property nodes to the graph
 * 
 * @param graph - The knowledge graph to add nodes to
 * @param files - Array of {path, content} objects for config files
 * @returns Number of properties indexed
 */
export function processConfigFiles(
  graph: {
    addNode: (node: GraphNode) => void;
    addRelationship: (rel: { id: string; type: string; sourceId: string; targetId: string; confidence: number; reason: string }) => void;
  },
  files: Array<{ path: string; content: string }>
): number {
  const configFileContents = files.filter(f => isConfigFile(f.path));
  
  if (configFileContents.length === 0) {
    return 0;
  }
  
  let propertyCount = 0;
  
  for (const { path, content } of configFileContents) {
    const result = indexConfigFile(content, path);
    
    // Create property nodes
    for (const prop of result.properties) {
      const node = propertyToGraphNode(prop);
      graph.addNode(node);
      propertyCount++;
    }
    
    // Create CONTAINS relationships from File to Properties
    const nodes = result.properties.map(propertyToGraphNode);
    const relationships = createPropertyRelationships(path, nodes);
    
    for (const rel of relationships) {
      graph.addRelationship(rel);
    }
  }
  
  return propertyCount;
}