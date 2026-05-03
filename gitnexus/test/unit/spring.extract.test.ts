import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships, getNodesByLabel, getNodesByLabelFull, runPipelineFromRepo, type PipelineResult,
} from '../integration/resolvers/helpers.js';

const JAVA_REST_API_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'lang-resolution', 'java-rest-api');

describe('Spring REST API route extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      JAVA_REST_API_FIXTURE,
      () => {},
    );
  }, 60000);

  it('creates Route nodes for AuthController endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    // AuthController has @RequestMapping("/auth") with @PostMapping("/login"), @PostMapping("/refresh"), @GetMapping("/users/me")
    expect(routes).toContain('POST /auth/login');
    expect(routes).toContain('POST /auth/refresh');
    expect(routes).toContain('GET /auth/users/me');
  });

  it('creates Route nodes for ProjectsController endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    // ProjectsController uses Constants.PROJECTS_PATH which should resolve to "/api/projects"
    expect(routes).toContain('GET /api/projects');
    expect(routes).toContain('GET /api/projects/{id}');
  });

  it('creates DEFINES edge from controller file to Route node', () => {
    const edges = getRelationships(result, 'DEFINES');
    // Filter for DEFINES edges where target is a Route node
    const routeDefinesEdges = edges.filter(e => e.targetLabel === 'Route');
    expect(routeDefinesEdges.length).toBeGreaterThan(0);

    // AuthController should define its routes
    const authRouteEdges = routeDefinesEdges.filter(e => e.sourceFilePath.includes('AuthController.java'));
    expect(authRouteEdges.length).toBeGreaterThan(0);

    // ProjectsController should define its routes
    const projectRouteEdges = routeDefinesEdges.filter(e => e.sourceFilePath.includes('ProjectsController.java'));
    expect(projectRouteEdges.length).toBeGreaterThan(0);
  });

  it('Route nodes have httpMethod and routePath properties', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const loginRoute = routes.find(r => r.name === 'POST /auth/login');
    expect(loginRoute).toBeDefined();
    expect(loginRoute?.properties.httpMethod).toBe('POST');
    expect(loginRoute?.properties.routePath).toBe('/auth/login');
  });
});
