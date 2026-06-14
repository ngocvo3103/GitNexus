import { describe, it, expect, vi } from "vitest";
import { processStructure } from "../../src/core/ingestion/structure-processor.js";
import type { KnowledgeGraph, GraphNode, GraphRelationship } from "../../src/core/graph/types.js";

// Mock generateId to return predictable IDs
vi.mock("../../src/lib/utils.js", () => ({
  generateId: vi.fn((...args: string[]) => args.join("::")),
}));

// Mock getFileType to delegate to the real implementation
vi.mock("../../src/core/ingestion/utils/language-detection.js", () => ({
  getFileType: vi.fn((filePath: string) => {
    if (filePath.endsWith(".ts") || filePath.endsWith(".java")) return "code";
    if (filePath.endsWith(".md")) return "documentation";
    if (filePath.endsWith(".xml")) return "config";
    if (filePath.endsWith(".json")) return "data";
    return "other";
  }),
}));

function makeGraph(): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  return {
    nodes,
    relationships,
    iterNodes: () => nodes[Symbol.iterator](),
    iterRelationships: () => relationships[Symbol.iterator](),
    forEachNode: (fn) => nodes.forEach(fn),
    forEachRelationship: (fn) => relationships.forEach(fn),
    getNode: (id) => nodes.find((n) => n.id === id),
    get nodeCount() { return nodes.length; },
    get relationshipCount() { return relationships.length; },
    addNode: (node) => nodes.push(node),
    addRelationship: (rel) => relationships.push(rel),
    removeNode: () => false,
    removeRelationship: () => false,
    removeNodesByFile: () => 0,
  } as KnowledgeGraph;
}

describe("processStructure", () => {
  it("adds fileType to File nodes", () => {
    const graph = makeGraph();
    processStructure(graph, ["src/main.ts"]);

    const fileNode = graph.nodes.find((n) => n.label === "File");
    expect(fileNode).toBeDefined();
    expect(fileNode!.properties).toHaveProperty("fileType", "code");
  });

  it("does NOT add fileType to Folder nodes", () => {
    const graph = makeGraph();
    processStructure(graph, ["src/utils/helpers.ts"]);

    const folderNode = graph.nodes.find((n) => n.label === "Folder");
    expect(folderNode).toBeDefined();
    expect(folderNode!.properties).not.toHaveProperty("fileType");
  });

  it("handles mixed paths with files and folders", () => {
    const graph = makeGraph();
    processStructure(graph, ["src/utils/helpers.ts", "README.md"]);

    const helpersNode = graph.nodes.find(
      (n) => n.label === "File" && n.properties.name === "helpers.ts",
    );
    expect(helpersNode!.properties).toHaveProperty("fileType", "code");

    const readmeNode = graph.nodes.find(
      (n) => n.label === "File" && n.properties.name === "README.md",
    );
    expect(readmeNode!.properties).toHaveProperty("fileType", "documentation");

    const srcNode = graph.nodes.find(
      (n) => n.label === "Folder" && n.properties.name === "src",
    );
    expect(srcNode!.properties).not.toHaveProperty("fileType");
  });

  it("returns correct fileType for multiple file extensions", () => {
    const graph = makeGraph();
    processStructure(graph, [
      "App.java",
      "config.xml",
      "package.json",
      "notes.md",
    ]);

    const javaNode = graph.nodes.find((n) => n.properties.name === "App.java");
    expect(javaNode!.properties.fileType).toBe("code");

    const xmlNode = graph.nodes.find((n) => n.properties.name === "config.xml");
    expect(xmlNode!.properties.fileType).toBe("config");

    const jsonNode = graph.nodes.find((n) => n.properties.name === "package.json");
    expect(jsonNode!.properties.fileType).toBe("data");

    const mdNode = graph.nodes.find((n) => n.properties.name === "notes.md");
    expect(mdNode!.properties.fileType).toBe("documentation");
  });
});