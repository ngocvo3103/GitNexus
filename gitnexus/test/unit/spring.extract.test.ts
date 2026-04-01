import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, getNodesByLabelFull, runPipelineFromRepo, type PipelineResult,
} from '../integration/resolvers/helpers.js';


describe('Spring REST API route mapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-rest-api'),
      () => {},
    );

  }, 60000);



  it('creates Route nodes for AuthController endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/auth/login');
    expect(routes).toContain('/auth/refresh');
    expect(routes).toContain('/auth/users/me');
  });

  it('creates Route nodes for ProjectController endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/projects');
    expect(routes).toContain('/api/projects/{id}');
  });

  it('creates HANDLES_ROUTE edge from controller file to Route node', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    // AuthController
    const loginRoute = edges.find(e => e.target === '/auth/login');
    expect(loginRoute).toBeDefined();
    expect(loginRoute!.sourceFilePath).toMatch(/AuthController\.java$/);
    // ProjectController
    const projectRoute = edges.find(e => e.target === '/api/projects');
    expect(projectRoute).toBeDefined();
    expect(projectRoute!.sourceFilePath).toMatch('controller/ProjectsController.java');
  });

  it('matches dynamic route segments', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/projects/{id}');
  });

  // Có thể bổ sung test cho edge FETCHES nếu repo mẫu có consumer fetch các route này
});
