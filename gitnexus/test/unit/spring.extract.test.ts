import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

describe('extractSpringRoutes - AuthController', () => {
  it('should extract correct routes for AuthController (inline string literals)', async () => {
    const javaSource = readFileSync(join(__dirname, 'AuthController.java'), 'utf8');
    const routes = await extractSpringRoutes(javaSource);
    expect(routes).toEqual([
      {
        path: '/auth/login',
        method: 'POST',
        controller: 'AuthController',
        handler: 'login',
        framework: 'spring',
        lineNumber: 26,
      },
      {
        path: '/auth/refresh',
        method: 'POST',
        controller: 'AuthController',
        handler: 'refresh',
        framework: 'spring',
        lineNumber: 32,
      },
      {
        path: '/auth/users/me',
        method: 'GET',
        controller: 'AuthController',
        handler: 'me',
        framework: 'spring',
        lineNumber: 38,
      },
    ]);
  });
});

describe('extractSpringRoutes - constant-based paths (same file)', () => {
  it('should resolve constants declared in the same file', async () => {
    const javaSource = readFileSync(join(__dirname, 'ProjectController.java'), 'utf8');
    const routes = await extractSpringRoutes(javaSource);
    expect(routes).toHaveLength(4);

    // @GetMapping(ApiPaths.PROJECTS) → prefix "/api/v1" + "projects" = "/api/v1/projects"
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/v1/projects', handler: 'list' }),
    );

    // @GetMapping(ApiPaths.PROJECT_BY_ID) → "projects/{id}" constant concat'd in ApiPaths
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/v1/projects/{id}', handler: 'getById' }),
    );

    // @PostMapping("/projects") → plain string literal still works
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/v1/projects', handler: 'create' }),
    );

    // @DeleteMapping(ApiPaths.PROJECTS + "/{id}") → inline concat expression
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/v1/projects/{id}', handler: 'delete' }),
    );
  });

  it('should resolve constants passed via externalConstants map (cross-file)', async () => {
    // Simulate a minimal controller that references a constant defined in another file
    const javaSource = `
package org.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(Config.API_PREFIX)
public class UserController {
    @GetMapping(Config.USER_PATH)
    public Object users() { return null; }
}
    `.trim();

    // Caller provides the resolved constants from Config.java
    const externalConstants = new Map([
      ['Config.API_PREFIX', '/api'],
      ['Config.USER_PATH', 'users'],
    ]);

    const routes = await extractSpringRoutes(javaSource, externalConstants);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: '/api/users',
      method: 'GET',
      controller: 'UserController',
      handler: 'users',
    });
  });
});
