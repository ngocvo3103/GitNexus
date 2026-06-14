import { describe, it, expect, beforeEach } from 'vitest';
import { processRoutesFromExtracted, processDecoratorRoutesWithRepoId, processNextjsRoutesWithRepoId, processExpoRoutesWithRepoId, processPHPRoutesWithRepoId } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExtractedRoute, ExtractedDecoratorRoute } from '../../src/core/ingestion/workers/parse-worker.js';

describe('processRoutesFromExtracted - Route node creation (Spring routes)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  // ============================================================================
  // Test 1: Route node creation with correct properties
  // ============================================================================
  describe('Route node creation', () => {
    it('creates Route node with correct properties when Spring route is extracted', async () => {
      // Setup: Add controller class and method to symbol table
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      // Verify Route node was created
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      
      const route = routeNodes[0];
      expect(route.properties.name).toBe('GET /users/{id}');
      expect(route.properties.filePath).toBe('src/controllers/UserController.java');
      expect(route.properties.startLine).toBe(42);
      
      // Verify Route-specific properties stored as direct properties (not in generic properties bag)
      expect(route.id).toMatch(/^Route:/);
      expect(route.properties.httpMethod).toBe('GET');
      expect(route.properties.routePath).toBe('/users/{id}');
      expect(route.properties.controllerName).toBe('UserController');
      expect(route.properties.methodName).toBe('getUser');
      expect(route.properties.lineNumber).toBe(42);
    });

    it('creates unique Route node id based on file, method, and routePath', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes[0].id).toBe('Route:src/controllers/UserController.java:GET:/users/{id}');
    });

    it('sets isInherited to false for direct controller method routes', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes[0].properties.isInherited).toBe(false);
    });
  });

  // ============================================================================
  // Test 2: DEFINES edge creation (File → Route)
  // ============================================================================
  describe('DEFINES edge creation', () => {
    it('creates DEFINES edge from File node to Route node', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const definesEdges = graph.relationships.filter(r => r.type === 'DEFINES');
      expect(definesEdges).toHaveLength(1);
      
      const fileId = 'File:src/controllers/UserController.java';
      const routeId = 'Route:src/controllers/UserController.java:GET:/users/{id}';
      
      expect(definesEdges[0].sourceId).toBe(fileId);
      expect(definesEdges[0].targetId).toBe(routeId);
    });

    it('creates DEFINES edge with confidence 1.0 (certain relationship)', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const definesEdges = graph.relationships.filter(r => r.type === 'DEFINES');
      expect(definesEdges[0].confidence).toBe(1.0);
    });
  });

  // ============================================================================
  // Test 3: CALLS edge creation (Route → Method)
  // ============================================================================
  describe('CALLS edge creation', () => {
    it('creates CALLS edge from Route node to Method node with reason=spring-route', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges).toHaveLength(1);
      
      const routeId = 'Route:src/controllers/UserController.java:GET:/users/{id}';
      const methodId = 'Method:src/controllers/UserController.java:getUser';
      
      expect(callsEdges[0].sourceId).toBe(routeId);
      expect(callsEdges[0].targetId).toBe(methodId);
      expect(callsEdges[0].reason).toBe('spring-route');
    });

    it('sets confidence based on resolution tier (same-file for controller method)', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      // Method resolved in same-file context = confidence 0.95
      expect(callsEdges[0].confidence).toBe(0.95);
    });

    it('creates CALLS edge with import-resolved confidence when method is in imported controller', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );
      ctx.importMap.set('src/routes/web.php', new Set(['src/controllers/UserController.java']));

      const routes: ExtractedRoute[] = [{
        filePath: 'src/routes/web.php',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 10,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges).toHaveLength(1);
      // Method resolved via import = confidence 0.9
      expect(callsEdges[0].confidence).toBe(0.9);
    });
  });

  // ============================================================================
  // Test 4: Laravel routes still work (backwards compatibility)
  // ============================================================================
  describe('Laravel route backwards compatibility', () => {
    it('existing Laravel routes still create CALLS edge with reason=laravel-route (no Route node)', async () => {
      ctx.symbols.add(
        'app/Http/Controllers/UserController.php',
        'UserController',
        'Class:app/Http/Controllers/UserController.php:UserController',
        'Class'
      );
      ctx.symbols.add(
        'app/Http/Controllers/UserController.php',
        'show',
        'Method:app/Http/Controllers/UserController.php:show',
        'Method',
        { ownerId: 'Class:app/Http/Controllers/UserController.php:UserController' }
      );

      // Laravel route: no controllerClass, uses string controller@method format
      const routes: ExtractedRoute[] = [{
        filePath: 'routes/web.php',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'show',
        middleware: ['auth'],
        prefix: null,
        lineNumber: 10,
        // isControllerClass is undefined or false for Laravel routes
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      // Laravel routes should NOT create Route nodes
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(0);

      // Laravel routes should still create CALLS edge with reason='laravel-route'
      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges).toHaveLength(1);
      expect(callsEdges[0].reason).toBe('laravel-route');
      
      // Edge should be from File to Method (not Route to Method)
      const fileId = 'File:routes/web.php';
      expect(callsEdges[0].sourceId).toBe(fileId);
    });

    it('mixed Spring and Laravel routes process correctly', async () => {
      // Setup for Spring route
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      // Setup for Laravel route
      ctx.symbols.add(
        'app/Http/Controllers/PostController.php',
        'PostController',
        'Class:app/Http/Controllers/PostController.php:PostController',
        'Class'
      );
      ctx.symbols.add(
        'app/Http/Controllers/PostController.php',
        'index',
        'Method:app/Http/Controllers/PostController.php:index',
        'Method',
        { ownerId: 'Class:app/Http/Controllers/PostController.php:PostController' }
      );
      ctx.importMap.set('routes/web.php', new Set(['app/Http/Controllers/PostController.php']));

      const routes: ExtractedRoute[] = [
        // Spring route
        {
          filePath: 'src/controllers/UserController.java',
          httpMethod: 'GET',
          routePath: '/users/{id}',
          controllerName: 'UserController',
          methodName: 'getUser',
          middleware: [],
          prefix: null,
          lineNumber: 42,
          isControllerClass: true,
        },
        // Laravel route
        {
          filePath: 'routes/web.php',
          httpMethod: 'GET',
          routePath: '/posts',
          controllerName: 'PostController',
          methodName: 'index',
          middleware: ['auth'],
          prefix: null,
          lineNumber: 10,
          // isControllerClass undefined for Laravel
        },
      ];

      await processRoutesFromExtracted(graph, routes, ctx);

      // One Route node for Spring route
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.routePath).toBe('/users/{id}');

      // Two CALLS edges total
      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges).toHaveLength(2);

      // Spring: Route → Method with reason='spring-route'
      const springCall = callsEdges.find(r => r.reason === 'spring-route');
      expect(springCall).toBeDefined();
      expect(springCall?.sourceId).toMatch(/^Route:/);

      // Laravel: File → Method with reason='laravel-route'
      const laravelCall = callsEdges.find(r => r.reason === 'laravel-route');
      expect(laravelCall).toBeDefined();
      expect(laravelCall?.sourceId).toBe('File:routes/web.php');

      // Spring: File → Route DEFINES edge
      const definesEdges = graph.relationships.filter(r => r.type === 'DEFINES');
      expect(definesEdges).toHaveLength(1);
      expect(definesEdges[0].sourceId).toBe('File:src/controllers/UserController.java');
      expect(definesEdges[0].targetId).toMatch(/^Route:/);
    });
  });

  // ============================================================================
  // Test 5: isInherited flag handling
  // ============================================================================
  describe('isInherited flag handling', () => {
    it('sets isInherited to true when method is inherited from parent class', async () => {
      // Controller class
      ctx.symbols.add(
        'src/controllers/AdminController.java',
        'AdminController',
        'Class:src/controllers/AdminController.java:AdminController',
        'Class'
      );
      // Base class with the actual method
      ctx.symbols.add(
        'src/controllers/BaseController.java',
        'BaseController',
        'Class:src/controllers/BaseController.java:BaseController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/BaseController.java',
        'listAll',
        'Method:src/controllers/BaseController.java:listAll',
        'Method',
        { ownerId: 'Class:src/controllers/BaseController.java:BaseController' }
      );
      // AdminController extends BaseController
      ctx.importMap.set('src/controllers/AdminController.java', new Set(['src/controllers/BaseController.java']));

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/AdminController.java',
        httpMethod: 'GET',
        routePath: '/admin/items',
        controllerName: 'AdminController',
        methodName: 'listAll', // method exists in parent class
        middleware: [],
        prefix: null,
        lineNumber: 15,
        isControllerClass: true,
        isInherited: true, // Signal that this is an inherited method
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.isInherited).toBe(true);
    });

    it('sets isInherited to false when method is defined in the same controller class', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
        // isInherited defaults to false or is undefined
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.isInherited).toBe(false);
    });

    it('defaults isInherited to false when not specified', async () => {
      ctx.symbols.add(
        'src/controllers/ProductController.java',
        'ProductController',
        'Class:src/controllers/ProductController.java:ProductController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/ProductController.java',
        'listProducts',
        'Method:src/controllers/ProductController.java:listProducts',
        'Method',
        { ownerId: 'Class:src/controllers/ProductController.java:ProductController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/ProductController.java',
        httpMethod: 'GET',
        routePath: '/products',
        controllerName: 'ProductController',
        methodName: 'listProducts',
        middleware: [],
        prefix: '/api',
        lineNumber: 25,
        isControllerClass: true,
        // isInherited not specified
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.isInherited).toBe(false);
    });
  });

  // ============================================================================
  // Test 6: Edge cases and error conditions
  // ============================================================================
  describe('edge cases', () => {
    it('skips route creation when controller is not resolved', async () => {
      // No symbols added - controller cannot be resolved

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/MissingController.java',
        httpMethod: 'GET',
        routePath: '/missing',
        controllerName: 'MissingController',
        methodName: 'handle',
        middleware: [],
        prefix: null,
        lineNumber: 10,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(0);
      expect(graph.relationshipCount).toBe(0);
    });

    it('skips route creation when method is not resolved', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      // Method not added - cannot be resolved

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'missingMethod',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(0);
      expect(graph.relationshipCount).toBe(0);
    });

    it('skips route creation when controller name is missing', async () => {
      const routes: ExtractedRoute[] = [{
        filePath: 'src/routes/routes.php',
        httpMethod: 'GET',
        routePath: '/orphan',
        controllerName: null, // Missing controller
        methodName: 'handle',
        middleware: [],
        prefix: null,
        lineNumber: 10,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      expect(graph.nodeCount).toBe(0);
      expect(graph.relationshipCount).toBe(0);
    });

    it('skips route creation when method name is missing', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: null, // Missing method
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(0);
      expect(graph.relationshipCount).toBe(0);
    });

    it('handles routes with prefix correctly in Route node id', async () => {
      ctx.symbols.add(
        'src/controllers/ApiController.java',
        'ApiController',
        'Class:src/controllers/ApiController.java:ApiController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/ApiController.java',
        'getUsers',
        'Method:src/controllers/ApiController.java:getUsers',
        'Method',
        { ownerId: 'Class:src/controllers/ApiController.java:ApiController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/ApiController.java',
        httpMethod: 'GET',
        routePath: '/users',
        controllerName: 'ApiController',
        methodName: 'getUsers',
        middleware: ['auth'],
        prefix: '/api/v1',
        lineNumber: 25,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      // Route path should be stored as-is (prefix handling is done elsewhere)
      expect(routeNodes[0].properties.routePath).toBe('/users');
    });

    it('handles multiple routes from the same controller', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'createUser',
        'Method:src/controllers/UserController.java:createUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'deleteUser',
        'Method:src/controllers/UserController.java:deleteUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [
        {
          filePath: 'src/controllers/UserController.java',
          httpMethod: 'GET',
          routePath: '/users/{id}',
          controllerName: 'UserController',
          methodName: 'getUser',
          middleware: [],
          prefix: null,
          lineNumber: 20,
          isControllerClass: true,
        },
        {
          filePath: 'src/controllers/UserController.java',
          httpMethod: 'POST',
          routePath: '/users',
          controllerName: 'UserController',
          methodName: 'createUser',
          middleware: [],
          prefix: null,
          lineNumber: 25,
          isControllerClass: true,
        },
        {
          filePath: 'src/controllers/UserController.java',
          httpMethod: 'DELETE',
          routePath: '/users/{id}',
          controllerName: 'UserController',
          methodName: 'deleteUser',
          middleware: [],
          prefix: null,
          lineNumber: 30,
          isControllerClass: true,
        },
      ];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(3);

      // Verify each route has correct httpMethod
      const httpMethods = routeNodes.map(n => n.properties.httpMethod).sort();
      expect(httpMethods).toEqual(['DELETE', 'GET', 'POST']);

      // Verify each route has a CALLS edge to its method
      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS' && r.reason === 'spring-route');
      expect(callsEdges).toHaveLength(3);

      // Verify each route has a DEFINES edge from the file
      const definesEdges = graph.relationships.filter(r => r.type === 'DEFINES');
      expect(definesEdges).toHaveLength(3);
    });

    it('calls progress callback during route processing', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      const onProgress = vi.fn();
      await processRoutesFromExtracted(graph, routes, ctx, onProgress);

      expect(onProgress).toHaveBeenCalledWith(1, 1);
    });

    it('handles empty routes array', async () => {
      await processRoutesFromExtracted(graph, [], ctx);
      expect(graph.nodeCount).toBe(0);
      expect(graph.relationshipCount).toBe(0);
    });
  });

  // ============================================================================
  // WI-12: repoId on Route nodes
  // ============================================================================
  describe('WI-12: repoId on Route nodes', () => {
    it('sets repoId on Route node when ctx.repoId is provided', async () => {
      const ctxWithRepoId = createResolutionContext();
      (ctxWithRepoId as any).repoId = 'tcbs-bond-trading';
      ctxWithRepoId.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctxWithRepoId.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctxWithRepoId);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBe('tcbs-bond-trading');
    });

    it('leaves repoId absent on Route node when ctx has no repoId', async () => {
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'UserController',
        'Class:src/controllers/UserController.java:UserController',
        'Class'
      );
      ctx.symbols.add(
        'src/controllers/UserController.java',
        'getUser',
        'Method:src/controllers/UserController.java:getUser',
        'Method',
        { ownerId: 'Class:src/controllers/UserController.java:UserController' }
      );

      const routes: ExtractedRoute[] = [{
        filePath: 'src/controllers/UserController.java',
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: null,
        lineNumber: 42,
        isControllerClass: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBeUndefined();
    });

    it('sets same repoId on multiple Route nodes from same context', async () => {
      const ctxWithRepoId = createResolutionContext();
      (ctxWithRepoId as any).repoId = 'tcbs-bond-trading';
      ctxWithRepoId.symbols.add(
        'src/controllers/OrderController.java',
        'OrderController',
        'Class:src/controllers/OrderController.java:OrderController',
        'Class'
      );
      ctxWithRepoId.symbols.add(
        'src/controllers/OrderController.java',
        'createOrder',
        'Method:src/controllers/OrderController.java:createOrder',
        'Method',
        { ownerId: 'Class:src/controllers/OrderController.java:OrderController' }
      );
      ctxWithRepoId.symbols.add(
        'src/controllers/OrderController.java',
        'getOrder',
        'Method:src/controllers/OrderController.java:getOrder',
        'Method',
        { ownerId: 'Class:src/controllers/OrderController.java:OrderController' }
      );

      const routes: ExtractedRoute[] = [
        {
          filePath: 'src/controllers/OrderController.java',
          httpMethod: 'POST',
          routePath: '/orders',
          controllerName: 'OrderController',
          methodName: 'createOrder',
          middleware: [],
          prefix: null,
          lineNumber: 25,
          isControllerClass: true,
        },
        {
          filePath: 'src/controllers/OrderController.java',
          httpMethod: 'GET',
          routePath: '/orders/{id}',
          controllerName: 'OrderController',
          methodName: 'getOrder',
          middleware: [],
          prefix: null,
          lineNumber: 30,
          isControllerClass: true,
        },
      ];

      await processRoutesFromExtracted(graph, routes, ctxWithRepoId);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(2);
      expect(routeNodes[0].properties.repoId).toBe('tcbs-bond-trading');
      expect(routeNodes[1].properties.repoId).toBe('tcbs-bond-trading');
    });
  });
});

// WI-12: repoId on non-Spring Route nodes (Expo, Next.js, Decorator, PHP)
// These test the WithRepoId variants used by pipeline.ts post-processing
describe('WI-12: repoId on non-Spring Route nodes (Expo/Next.js/Decorator/PHP)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  describe('processDecoratorRoutesWithRepoId', () => {
    it('sets repoId on Route node created from decorator route', async () => {
      const { processDecoratorRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const decoratorRoutes = [{
        filePath: 'src/routes/users.ts',
        decorator: 'get',
        method: 'getUser',
        path: '/users/:id',
        lineNumber: 10,
      }];

      processDecoratorRoutesWithRepoId(graph, decoratorRoutes, 'my-repo');

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBe('my-repo');
      expect(routeNodes[0].properties.routePath).toBe('/users/:id');
      expect(routeNodes[0].properties.httpMethod).toBe('GET');
    });

    it('sets repoId on multiple Route nodes from decorator routes', async () => {
      const { processDecoratorRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const decoratorRoutes = [
        { filePath: 'src/routes/users.ts', decorator: 'get', method: 'getUser', path: '/users/:id', lineNumber: 10 },
        { filePath: 'src/routes/users.ts', decorator: 'post', method: 'createUser', path: '/users', lineNumber: 15 },
      ];

      processDecoratorRoutesWithRepoId(graph, decoratorRoutes, 'tcbs-bond');

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(2);
      expect(routeNodes[0].properties.repoId).toBe('tcbs-bond');
      expect(routeNodes[1].properties.repoId).toBe('tcbs-bond');
    });

    it('skips routes with invalid HTTP method', async () => {
      const { processDecoratorRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const decoratorRoutes = [
        { filePath: 'src/routes/users.ts', decorator: 'custom', method: 'handler', path: '/custom', lineNumber: 10 },
      ];

      processDecoratorRoutesWithRepoId(graph, decoratorRoutes, 'my-repo');

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(0);
    });
  });

  describe('processNextjsRoutesWithRepoId', () => {
    it('sets repoId on Route node created from Next.js route file', async () => {
      const { processNextjsRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const fileContents = new Map<string, string>([
        ['app/api/users/route.ts', 'export async function GET() { return Response.json({}); }'],
      ]);

      const routeRegistry = processNextjsRoutesWithRepoId(
        graph,
        ['app/api/users/route.ts'],
        fileContents,
        'nextjs-repo',
      );

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBe('nextjs-repo');
      expect(routeNodes[0].properties.routePath).toBe('/api/users');
    });

    it('sets repoId on multiple Next.js Route nodes', async () => {
      const { processNextjsRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const fileContents = new Map<string, string>([
        ['app/api/users/route.ts', 'export async function GET() { return Response.json({}); }'],
        ['app/api/posts/route.ts', 'export async function POST() { return Response.json({}); }'],
      ]);

      processNextjsRoutesWithRepoId(
        graph,
        ['app/api/users/route.ts', 'app/api/posts/route.ts'],
        fileContents,
        'my-nextjs-app',
      );

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(2);
      expect(routeNodes[0].properties.repoId).toBe('my-nextjs-app');
      expect(routeNodes[1].properties.repoId).toBe('my-nextjs-app');
    });
  });

  describe('processExpoRoutesWithRepoId', () => {
    it('sets repoId on Route node created from Expo Router file', async () => {
      const { processExpoRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');

      const routeRegistry = processExpoRoutesWithRepoId(
        graph,
        ['app/(tabs)/index.tsx'],
        'expo-repo',
      );

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBe('expo-repo');
      expect(routeNodes[0].properties.routeType).toBe('expo-router');
    });

    it('sets repoId on multiple Expo Route nodes', async () => {
      const { processExpoRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');

      processExpoRoutesWithRepoId(
        graph,
        ['app/(tabs)/index.tsx', 'app/settings.tsx'],
        'my-expo-app',
      );

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(2);
      expect(routeNodes[0].properties.repoId).toBe('my-expo-app');
      expect(routeNodes[1].properties.repoId).toBe('my-expo-app');
    });
  });

  describe('processPHPRoutesWithRepoId', () => {
    it('sets repoId on Route node created from PHP api file', async () => {
      const { processPHPRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const phpFileContents = new Map<string, string>([
        ['api/users.php', '<?php json_encode(["id" => 1]);'],
      ]);

      processPHPRoutesWithRepoId(graph, ['api/users.php'], phpFileContents, 'php-repo');

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(1);
      expect(routeNodes[0].properties.repoId).toBe('php-repo');
      expect(routeNodes[0].properties.routePath).toBe('/api/users');
    });

    it('sets repoId on multiple PHP Route nodes', async () => {
      const { processPHPRoutesWithRepoId } = await import('../../src/core/ingestion/call-processor.js');
      const phpFileContents = new Map<string, string>([
        ['api/users.php', '<?php json_encode(["id" => 1]);'],
        ['api/posts.php', '<?php json_encode(["id" => 1]);'],
      ]);

      processPHPRoutesWithRepoId(graph, ['api/users.php', 'api/posts.php'], phpFileContents, 'tcbs-php');

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes).toHaveLength(2);
      expect(routeNodes[0].properties.repoId).toBe('tcbs-php');
      expect(routeNodes[1].properties.repoId).toBe('tcbs-php');
    });
  });
});

// Import vi for mock function
import { vi } from 'vitest';