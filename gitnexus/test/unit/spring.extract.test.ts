import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

describe('extractSpringRoutes - AuthController', () => {
  it('should extract correct routes for AuthController', async () => {
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

