import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

/**
 * Seed data for impacted_endpoints E2E tests.
 *
 * Multi-language seed data covering Java/Spring, Python/FastAPI, Go/Gin,
 * and TypeScript/Angular projects.
 *
 * Java/Spring (6 File, 5 Route, 8 Method, 6 Class):
 * - 5 Route endpoints (UserController, OrderController, HealthController)
 * - 8 Method nodes (handlers + service/utility methods)
 * - 6 Class nodes (controllers, service, utility, base class)
 * - 6 File nodes
 * - Transitive CALLS chain: FormatUtil → UserService → UserController handler
 * - EXTENDS chain: HealthController extends BaseController
 * - IMPORTS edges between files and classes
 *
 * Python/FastAPI (3 File, 3 Route, 4 Method, 2 Class):
 * - 3 Route endpoints (users router, auth router)
 * - 4 Method nodes (handlers + lookup)
 * - Transitive CALLS chain: create_user → get_user_by_id
 *
 * Go/Gin (3 File, 2 Route, 4 Method, 2 Class):
 * - 2 Route endpoints (OrderHandler)
 * - 4 Method nodes (handler + service)
 * - Transitive CALLS chain: CreateOrder → ValidateOrder → ProcessPayment
 *
 * TypeScript/Angular (2 File, 0 Route, 2 Method, 1 Class):
 * - Frontend: no Route nodes (tests "no endpoint" scenario)
 * - Method→Method CALLS: navigateToUsers → fetchUsers
 *
 * Cross-repo exports for multi-repo E2E tests:
 * - IMPACTED_ENDPOINTS_CROSS_REPO_CONSUMER_SEED: Java/Spring + verifyToken + File→File IMPORTS
 * - IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED: EmailValidator library
 * - IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED: Both consumer + library data + IMPORTS edge
 *
 * Key test scenarios:
 * 1. Transitive chain (LIKELY_AFFECTED): Changing FormatUtil.java → method-formatUser
 *    (d=1) → method-getUsers-svc (d=2) → method-getUsers (d=3) → route-get-users
 *    via reverse-CALLS. Result: GET /api/users → LIKELY_AFFECTED tier.
 * 2. Direct chain (WILL_BREAK): Changing UserController.java → file-UserController →
 *    DEFINES → route-post-users. Result: POST /api/users → WILL_BREAK tier.
 * 3. No route directly reachable from FormatUtil — transitive BFS still finds routes.
 * 4. Frontend no-endpoint: TypeScript/Angular has Methods+Classes but no Routes.
 * 5. Cross-repo: Changing EmailValidator.validateEmail in library repo affects
 *    consumer's verifyToken → getUsers-svc → getUsers → route-get-users.
 */

/** Java/Spring seed data — shared between main and cross-repo-consumer arrays. */
const JAVA_SPRING_SEED_DATA = [
  // ─── File nodes (7) ──────────────────────────────────────────────────
  `CREATE (f:File {id: 'file-UserController', name: 'UserController.java', filePath: 'UserController.java', content: 'UserController with GET and POST endpoints', repoId: ''})`,
  `CREATE (f:File {id: 'file-OrderController', name: 'OrderController.java', filePath: 'OrderController.java', content: 'OrderController with GET and DELETE endpoints', repoId: ''})`,
  `CREATE (f:File {id: 'file-HealthController', name: 'HealthController.java', filePath: 'HealthController.java', content: 'HealthController extends BaseController', repoId: ''})`,
  `CREATE (f:File {id: 'file-BaseController', name: 'BaseController.java', filePath: 'BaseController.java', content: 'BaseController with health check support', repoId: ''})`,
  `CREATE (f:File {id: 'file-UserService', name: 'UserService.java', filePath: 'UserService.java', content: 'UserService business logic', repoId: ''})`,
  `CREATE (f:File {id: 'file-FormatUtil', name: 'FormatUtil.java', filePath: 'FormatUtil.java', content: 'FormatUtil string formatting utility', repoId: ''})`,

  // ─── Route nodes (5) ──────────────────────────────────────────────────
  `CREATE (r:Route {id: 'route-get-users', name: '/api/users', httpMethod: 'GET', routePath: '/api/users', controllerName: 'UserController', methodName: 'getUsers', filePath: 'UserController.java', startLine: 25, lineNumber: 25, isInherited: false, repoId: '', responseKeys: ['users', 'totalCount'], errorKeys: ['error'], middleware: []})`,
  `CREATE (r:Route {id: 'route-post-users', name: '/api/users', httpMethod: 'POST', routePath: '/api/users', controllerName: 'UserController', methodName: 'createUser', filePath: 'UserController.java', startLine: 42, lineNumber: 42, isInherited: false, repoId: '', responseKeys: ['id', 'name'], errorKeys: ['error', 'message'], middleware: []})`,
  `CREATE (r:Route {id: 'route-get-orders', name: '/api/orders/{id}', httpMethod: 'GET', routePath: '/api/orders/{id}', controllerName: 'OrderController', methodName: 'getOrder', filePath: 'OrderController.java', startLine: 30, lineNumber: 30, isInherited: false, repoId: '', responseKeys: ['order'], errorKeys: ['error'], middleware: []})`,
  `CREATE (r:Route {id: 'route-delete-orders', name: '/api/orders/{id}', httpMethod: 'DELETE', routePath: '/api/orders/{id}', controllerName: 'OrderController', methodName: 'deleteOrder', filePath: 'OrderController.java', startLine: 55, lineNumber: 55, isInherited: false, repoId: '', responseKeys: [], errorKeys: ['error'], middleware: []})`,
  `CREATE (r:Route {id: 'route-get-health', name: '/api/health', httpMethod: 'GET', routePath: '/api/health', controllerName: 'HealthController', methodName: 'health', filePath: 'HealthController.java', startLine: 15, lineNumber: 15, isInherited: true, repoId: '', responseKeys: ['status'], errorKeys: [], middleware: []})`,

  // ─── Method nodes (8) ──────────────────────────────────────────────────
  `CREATE (m:Method {id: 'method-getUsers', name: 'getUsers', filePath: 'UserController.java', startLine: 25, endLine: 35, isExported: false, content: '@GetMapping("/api/users") public List<User> getUsers()', description: 'Get all users', parameterCount: 0, returnType: 'List<User>', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-createUser', name: 'createUser', filePath: 'UserController.java', startLine: 42, endLine: 55, isExported: false, content: 'public User createUser(@RequestBody User user)', description: 'Create a new user', parameterCount: 1, returnType: 'User', parameters: '[User]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-getOrder', name: 'getOrder', filePath: 'OrderController.java', startLine: 30, endLine: 40, isExported: false, content: 'public Order getOrder(@PathVariable Long id)', description: 'Get order by ID', parameterCount: 1, returnType: 'Order', parameters: '[Long]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-deleteOrder', name: 'deleteOrder', filePath: 'OrderController.java', startLine: 55, endLine: 65, isExported: false, content: 'public void deleteOrder(@PathVariable Long id)', description: 'Delete order by ID', parameterCount: 1, returnType: 'void', parameters: '[Long]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-getUsers-svc', name: 'getUsers', filePath: 'UserService.java', startLine: 10, endLine: 20, isExported: false, content: 'public List<User> getUsers()', description: 'Service layer: get all users', parameterCount: 0, returnType: 'List<User>', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-formatUser', name: 'formatUser', filePath: 'FormatUtil.java', startLine: 5, endLine: 12, isExported: true, content: 'public static String formatUser(User user)', description: 'Format a user for display', parameterCount: 1, returnType: 'String', parameters: '[User]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-health', name: 'health', filePath: 'HealthController.java', startLine: 15, endLine: 20, isExported: false, content: 'public ResponseEntity health()', description: 'Health check endpoint', parameterCount: 0, returnType: 'ResponseEntity', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-baseHealth', name: 'baseHealth', filePath: 'BaseController.java', startLine: 8, endLine: 15, isExported: false, content: 'protected ResponseEntity baseHealth()', description: 'Base health check logic', parameterCount: 0, returnType: 'ResponseEntity', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── Class nodes (6) ──────────────────────────────────────────────────
  `CREATE (c:Class {id: 'class-UserController', name: 'UserController', filePath: 'UserController.java', startLine: 10, endLine: 60, isExported: true, content: '@RestController class UserController', description: 'User REST controller', fields: '[]', annotations: '[@RestController]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-OrderController', name: 'OrderController', filePath: 'OrderController.java', startLine: 10, endLine: 70, isExported: true, content: '@RestController class OrderController', description: 'Order REST controller', fields: '[]', annotations: '[@RestController]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-HealthController', name: 'HealthController', filePath: 'HealthController.java', startLine: 5, endLine: 25, isExported: true, content: '@RestController class HealthController extends BaseController', description: 'Health check controller', fields: '[]', annotations: '[@RestController]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-BaseController', name: 'BaseController', filePath: 'BaseController.java', startLine: 1, endLine: 20, isExported: true, content: 'class BaseController', description: 'Base controller with shared utilities', fields: '[]', annotations: '[]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-UserService', name: 'UserService', filePath: 'UserService.java', startLine: 5, endLine: 30, isExported: true, content: '@Service class UserService', description: 'User business logic service', fields: '[]', annotations: '[@Service]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-FormatUtil', name: 'FormatUtil', filePath: 'FormatUtil.java', startLine: 1, endLine: 15, isExported: true, content: 'public class FormatUtil', description: 'String formatting utility', fields: '[]', annotations: '[]', repoId: ''})`,

  // ─── DEFINES edges: File → Route (4) ──────────────────────────────────
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-UserController' AND r.id = 'route-post-users'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-OrderController' AND r.id = 'route-get-orders'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-OrderController' AND r.id = 'route-delete-orders'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-HealthController' AND r.id = 'route-get-health'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,

  // ─── CALLS edges: Route → Method (5) ───────────────────────────────────
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-users' AND m.id = 'method-getUsers'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-post-users' AND m.id = 'method-createUser'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-orders' AND m.id = 'method-getOrder'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-delete-orders' AND m.id = 'method-deleteOrder'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-health' AND m.id = 'method-health'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,

  // ─── HAS_METHOD edges: Class → Method (8) ──────────────────────────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserController' AND m.id = 'method-getUsers'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserController' AND m.id = 'method-createUser'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderController' AND m.id = 'method-getOrder'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderController' AND m.id = 'method-deleteOrder'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserService' AND m.id = 'method-getUsers-svc'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-FormatUtil' AND m.id = 'method-formatUser'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-HealthController' AND m.id = 'method-health'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-BaseController' AND m.id = 'method-baseHealth'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── CALLS edges: Method → Method (transitive chain) ───────────────────
  // method-getUsers calls method-getUsers-svc (controller delegates to service)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-getUsers' AND b.id = 'method-getUsers-svc'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.95, reason: 'direct-call', step: 0}]->(b)`,
  // method-getUsers-svc calls method-formatUser (service uses utility)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-getUsers-svc' AND b.id = 'method-formatUser'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'import-resolved', step: 0}]->(b)`,

  // ─── EXTENDS edge: Class → Class (1) ───────────────────────────────────
  `MATCH (c:Class), (b:Class) WHERE c.id = 'class-HealthController' AND b.id = 'class-BaseController'
   CREATE (c)-[:CodeRelation {type: 'EXTENDS', confidence: 1.0, reason: 'class-extension', step: 0}]->(b)`,

  // ─── IMPORTS edges: File → Class (2) ───────────────────────────────────
  `MATCH (f:File), (c:Class) WHERE f.id = 'file-UserController' AND c.id = 'class-UserService'
   CREATE (f)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import-statement', step: 0}]->(c)`,
  `MATCH (f:File), (c:Class) WHERE f.id = 'file-UserService' AND c.id = 'class-FormatUtil'
   CREATE (f)-[:CodeRelation {type: 'IMPORTS', confidence: 0.9, reason: 'import-statement', step: 0}]->(c)`,
];

export const IMPACTED_ENDPOINTS_SEED_DATA = [
  ...JAVA_SPRING_SEED_DATA,

  // ═══════════════════════════════════════════════════════════════════════
  // Python/FastAPI section
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Python/FastAPI: File nodes (3) ──────────────────────────────────
  `CREATE (f:File {id: 'file-app_main_py', name: 'app/main.py', filePath: 'app/main.py', content: 'FastAPI main application', repoId: ''})`,
  `CREATE (f:File {id: 'file-users_py', name: 'app/users.py', filePath: 'app/users.py', content: 'FastAPI users router with GET and POST endpoints', repoId: ''})`,
  `CREATE (f:File {id: 'file-auth_service_py', name: 'app/auth_service.py', filePath: 'app/auth_service.py', content: 'FastAPI auth service with login endpoint', repoId: ''})`,

  // ─── Python/FastAPI: Route nodes (3) ─────────────────────────────────
  `CREATE (r:Route {id: 'route-get-users-fastapi', name: '/api/users', httpMethod: 'GET', routePath: '/api/users', controllerName: 'users', methodName: 'list_users', filePath: 'app/users.py', startLine: 15, lineNumber: 15, isInherited: false, repoId: '', responseKeys: ['users'], errorKeys: ['detail'], middleware: []})`,
  `CREATE (r:Route {id: 'route-post-users-fastapi', name: '/api/users', httpMethod: 'POST', routePath: '/api/users', controllerName: 'users', methodName: 'create_user', filePath: 'app/users.py', startLine: 30, lineNumber: 30, isInherited: false, repoId: '', responseKeys: ['id', 'name'], errorKeys: ['detail'], middleware: []})`,
  `CREATE (r:Route {id: 'route-post-login-fastapi', name: '/api/login', httpMethod: 'POST', routePath: '/api/login', controllerName: 'auth', methodName: 'login', filePath: 'app/auth_service.py', startLine: 10, lineNumber: 10, isInherited: false, repoId: '', responseKeys: ['token'], errorKeys: ['detail'], middleware: []})`,

  // ─── Python/FastAPI: Method nodes (4) ───────────────────────────────
  `CREATE (m:Method {id: 'method-list_users', name: 'list_users', filePath: 'app/users.py', startLine: 15, endLine: 20, isExported: true, content: 'def list_users(): return user_service.get_users()', description: 'List all users', parameterCount: 0, returnType: 'list', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-create_user', name: 'create_user', filePath: 'app/users.py', startLine: 30, endLine: 40, isExported: true, content: '@router.post("/users") def create_user(user: User): ...', description: 'Create a new user', parameterCount: 1, returnType: 'User', parameters: '[User]', annotations: '[@router.post("/users")]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-login', name: 'login', filePath: 'app/auth_service.py', startLine: 10, endLine: 20, isExported: true, content: '@router.post("/login") def login(credentials): ...', description: 'Authenticate user', parameterCount: 1, returnType: 'Token', parameters: '[Credentials]', annotations: '[@router.post("/login")]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-get_user_by_id', name: 'get_user_by_id', filePath: 'app/users.py', startLine: 45, endLine: 55, isExported: true, content: 'def get_user_by_id(id: int): ...', description: 'Get user by ID', parameterCount: 1, returnType: 'User', parameters: '[int]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── Python/FastAPI: Class nodes (2) ─────────────────────────────────
  `CREATE (c:Class {id: 'class-users', name: 'users', filePath: 'app/users.py', startLine: 1, endLine: 60, isExported: true, content: 'FastAPI users router', description: 'Users API router', fields: '[]', annotations: '[@router]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-auth', name: 'auth', filePath: 'app/auth_service.py', startLine: 1, endLine: 30, isExported: true, content: 'FastAPI auth router', description: 'Auth API router', fields: '[]', annotations: '[@router]', repoId: ''})`,

  // ─── Python/FastAPI: DEFINES edges: File → Route (3) ──────────────────
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-users_py' AND r.id = 'route-get-users-fastapi'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-users_py' AND r.id = 'route-post-users-fastapi'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-auth_service_py' AND r.id = 'route-post-login-fastapi'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,

  // ─── Python/FastAPI: CALLS edges: Route → Method (3) ──────────────────
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-users-fastapi' AND m.id = 'method-list_users'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-post-users-fastapi' AND m.id = 'method-create_user'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-post-login-fastapi' AND m.id = 'method-login'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,

  // ─── Python/FastAPI: HAS_METHOD edges: Class → Method (3) ─────────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-users' AND m.id = 'method-list_users'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-users' AND m.id = 'method-create_user'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-auth' AND m.id = 'method-login'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── Python/FastAPI: CALLS edges: Method → Method (transitive) ────────
  // method-create_user calls method-get_user_by_id (handler delegates to lookup)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-create_user' AND b.id = 'method-get_user_by_id'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'direct-call', step: 0}]->(b)`,

  // ═══════════════════════════════════════════════════════════════════════
  // Go/Gin section
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Go/Gin: File nodes (3) ──────────────────────────────────────────
  `CREATE (f:File {id: 'file-main_go', name: 'main.go', filePath: 'main.go', content: 'Gin main application setup', repoId: ''})`,
  `CREATE (f:File {id: 'file-handlers_go', name: 'handlers/order.go', filePath: 'handlers/order.go', content: 'Gin order handlers', repoId: ''})`,
  `CREATE (f:File {id: 'file-service_go', name: 'services/order_service.go', filePath: 'services/order_service.go', content: 'Gin order service logic', repoId: ''})`,

  // ─── Go/Gin: Route nodes (2) ────────────────────────────────────────
  `CREATE (r:Route {id: 'route-get-orders-gin', name: '/orders/{id}', httpMethod: 'GET', routePath: '/orders/{id}', controllerName: 'OrderHandler', methodName: 'GetOrder', filePath: 'handlers/order.go', startLine: 20, lineNumber: 20, isInherited: false, repoId: '', responseKeys: ['order'], errorKeys: ['error'], middleware: []})`,
  `CREATE (r:Route {id: 'route-post-orders-gin', name: '/orders', httpMethod: 'POST', routePath: '/orders', controllerName: 'OrderHandler', methodName: 'CreateOrder', filePath: 'handlers/order.go', startLine: 35, lineNumber: 35, isInherited: false, repoId: '', responseKeys: ['id'], errorKeys: ['error'], middleware: []})`,

  // ─── Go/Gin: Method nodes (4) ────────────────────────────────────────
  `CREATE (m:Method {id: 'method-GetOrder', name: 'GetOrder', filePath: 'handlers/order.go', startLine: 20, endLine: 30, isExported: true, content: 'func (h *OrderHandler) GetOrder(c *gin.Context) { ... }', description: 'Get order by ID', parameterCount: 1, returnType: 'error', parameters: '[*gin.Context]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-CreateOrder', name: 'CreateOrder', filePath: 'handlers/order.go', startLine: 35, endLine: 50, isExported: true, content: 'func (h *OrderHandler) CreateOrder(c *gin.Context) { ... }', description: 'Create a new order', parameterCount: 1, returnType: 'error', parameters: '[*gin.Context]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-ValidateOrder', name: 'ValidateOrder', filePath: 'services/order_service.go', startLine: 10, endLine: 25, isExported: true, content: 'func (s *OrderService) ValidateOrder(order Order) error { ... }', description: 'Validate order fields', parameterCount: 1, returnType: 'error', parameters: '[Order]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-ProcessPayment', name: 'ProcessPayment', filePath: 'services/order_service.go', startLine: 30, endLine: 45, isExported: true, content: 'func (s *OrderService) ProcessPayment(order Order) error { ... }', description: 'Process order payment', parameterCount: 1, returnType: 'error', parameters: '[Order]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── Go/Gin: Class nodes (2) ─────────────────────────────────────────
  `CREATE (c:Class {id: 'class-OrderHandler', name: 'OrderHandler', filePath: 'handlers/order.go', startLine: 5, endLine: 55, isExported: true, content: 'type OrderHandler struct { ... }', description: 'Order HTTP handler', fields: '[]', annotations: '[]', repoId: ''})`,
  `CREATE (c:Class {id: 'class-OrderService', name: 'OrderService', filePath: 'services/order_service.go', startLine: 1, endLine: 50, isExported: true, content: 'type OrderService struct { ... }', description: 'Order business logic service', fields: '[]', annotations: '[]', repoId: ''})`,

  // ─── Go/Gin: DEFINES edges: File → Route (2) ──────────────────────────
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-handlers_go' AND r.id = 'route-get-orders-gin'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,
  `MATCH (f:File), (r:Route) WHERE f.id = 'file-handlers_go' AND r.id = 'route-post-orders-gin'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'route-handler', step: 0}]->(r)`,

  // ─── Go/Gin: CALLS edges: Route → Method (2) ──────────────────────────
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-orders-gin' AND m.id = 'method-GetOrder'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
  `MATCH (r:Route), (m:Method) WHERE r.id = 'route-post-orders-gin' AND m.id = 'method-CreateOrder'
   CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,

  // ─── Go/Gin: HAS_METHOD edges: Class → Method (4) ─────────────────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderHandler' AND m.id = 'method-GetOrder'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderHandler' AND m.id = 'method-CreateOrder'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderService' AND m.id = 'method-ValidateOrder'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-OrderService' AND m.id = 'method-ProcessPayment'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── Go/Gin: CALLS edges: Method → Method (transitive chain) ───────────
  // method-CreateOrder calls method-ValidateOrder (handler delegates to service)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-CreateOrder' AND b.id = 'method-ValidateOrder'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.95, reason: 'direct-call', step: 0}]->(b)`,
  // method-ValidateOrder calls method-ProcessPayment (validation triggers payment)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-ValidateOrder' AND b.id = 'method-ProcessPayment'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'direct-call', step: 0}]->(b)`,

  // ═══════════════════════════════════════════════════════════════════════
  // TypeScript/Angular section (frontend — no Route nodes)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── TypeScript/Angular: File nodes (2) ───────────────────────────────
  `CREATE (f:File {id: 'file-app_routes_ts', name: 'src/app/app.routes.ts', filePath: 'src/app/app.routes.ts', content: 'Angular app routing configuration', repoId: ''})`,
  `CREATE (f:File {id: 'file-user_service_ts', name: 'src/app/services/user.service.ts', filePath: 'src/app/services/user.service.ts', content: 'Angular user service with HTTP calls', repoId: ''})`,

  // ─── TypeScript/Angular: Method nodes (2) ────────────────────────────
  `CREATE (m:Method {id: 'method-navigateToUsers', name: 'navigateToUsers', filePath: 'src/app/app.routes.ts', startLine: 10, endLine: 15, isExported: false, content: 'navigateToUsers() { this.router.navigate(["/users"]); }', description: 'Navigate to users page', parameterCount: 0, returnType: 'void', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
  `CREATE (m:Method {id: 'method-fetchUsers', name: 'fetchUsers', filePath: 'src/app/services/user.service.ts', startLine: 8, endLine: 12, isExported: false, content: 'fetchUsers() { return this.http.get("/api/users"); }', description: 'Fetch users from API', parameterCount: 0, returnType: 'Observable<User[]>', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── TypeScript/Angular: Class nodes (1) ─────────────────────────────
  `CREATE (c:Class {id: 'class-UserService-ts', name: 'UserService', filePath: 'src/app/services/user.service.ts', startLine: 5, endLine: 20, isExported: true, content: 'Angular UserService with HTTP client', description: 'User HTTP service', fields: '[]', annotations: '[@Injectable]', repoId: ''})`,

  // ─── TypeScript/Angular: HAS_METHOD edges: Class → Method (2) ─────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserService-ts' AND m.id = 'method-navigateToUsers'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 0.8, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserService-ts' AND m.id = 'method-fetchUsers'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── TypeScript/Angular: CALLS edges: Method → Method (1) ─────────────
  // method-navigateToUsers calls method-fetchUsers (navigation triggers data fetch)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-navigateToUsers' AND b.id = 'method-fetchUsers'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.8, reason: 'direct-call', step: 0}]->(b)`,
];

export const IMPACTED_ENDPOINTS_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Route', indexName: 'route_fts', columns: ['name', 'httpMethod', 'routePath', 'controllerName', 'methodName'] },
];

/**
 * Consumer repo seed for cross-repo E2E tests.
 * Extends Java/Spring with a cross-repo import (verifyToken) that calls into
 * the shared-libs EmailValidator (loaded separately via IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED).
 *
 * Impact chain across repos:
 *   EmailValidator.validateEmail (library) ← sanitizeEmail CALLS validateEmail
 *   UserService.verifyToken (consumer) ← getUsers-svc CALLS verifyToken
 *   route-get-users ← getUsers ← getUsers-svc ← verifyToken
 */
export const IMPACTED_ENDPOINTS_CROSS_REPO_CONSUMER_SEED = [
  ...JAVA_SPRING_SEED_DATA,

  // ─── Additional consumer Method node (1) ──────────────────────────────
  `CREATE (m:Method {id: 'method-verifyToken', name: 'verifyToken', filePath: 'UserService.java', startLine: 35, endLine: 45, isExported: false, content: 'public boolean verifyToken(String token)', description: 'Verify JWT token via email validator', parameterCount: 1, returnType: 'boolean', parameters: '[String]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── Additional CALLS edge: getUsers-svc → verifyToken ────────────────
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-getUsers-svc' AND b.id = 'method-verifyToken'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'import-resolved', step: 0}]->(b)`,

  // ─── Additional HAS_METHOD edge: UserService → verifyToken ───────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserService' AND m.id = 'method-verifyToken'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── Cross-repo File→File IMPORTS edge ─────────────────────────────────
  // UserService.java imports EmailValidator.java from shared-libs
  // This is the key edge for CrossRepoResolver Stage 1 (file-imports match)
  `MATCH (f:File), (t:File) WHERE f.id = 'file-UserService' AND t.id = 'file-EmailValidator_java'
   CREATE (f)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'cross-repo-import', step: 0}]->(t)`,
];

/**
 * Combined seed for cross-repo E2E tests.
 * Contains BOTH consumer and library data in a single graph, plus
 * the cross-repo File→File IMPORTS edge that bridges them.
 * This simulates what a consumer's graph would look like when it
 * imports from a shared library (with shadow File nodes for the library).
 *
 * Impact chains:
 *   IMPORTS chain: UserService.java ←[IMPORTS]─ EmailValidator.java
 *   CALLS chain:   verifyToken → getUsers-svc → getUsers → route-get-users
 *                   verifyToken ←[CALLS]─ sanitizeEmail (library)
 */
export const IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED = [
  ...JAVA_SPRING_SEED_DATA,

  // ─── Additional consumer Method node (1) ──────────────────────────────
  `CREATE (m:Method {id: 'method-verifyToken', name: 'verifyToken', filePath: 'UserService.java', startLine: 35, endLine: 45, isExported: false, content: 'public boolean verifyToken(String token)', description: 'Verify JWT token via email validator', parameterCount: 1, returnType: 'boolean', parameters: '[String]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,

  // ─── Additional CALLS edge: getUsers-svc → verifyToken ────────────────
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-getUsers-svc' AND b.id = 'method-verifyToken'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'import-resolved', step: 0}]->(b)`,

  // ─── Additional HAS_METHOD edge: UserService → verifyToken ───────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-UserService' AND m.id = 'method-verifyToken'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── Library shadow nodes (in consumer's graph) ────────────────────────
  // These represent the imported library file and its symbols,
  // as they would appear in a real indexed consumer repo that
  // imports from shared-libs.
  `CREATE (f:File {id: 'file-EmailValidator_java', name: 'EmailValidator.java', filePath: 'EmailValidator.java', content: 'Email validation utility', repoId: ''})`,

  // ─── Cross-repo File→File IMPORTS edge ─────────────────────────────────
  // UserService.java imports EmailValidator.java from shared-libs
  // This is the key edge for CrossRepoResolver Stage 1 (file-imports match)
  `MATCH (f:File), (t:File) WHERE f.id = 'file-UserService' AND t.id = 'file-EmailValidator_java'
   CREATE (f)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'cross-repo-import', step: 0}]->(t)`,
];

/**
 * Library repo seed for cross-repo E2E tests.
 * Loaded into a separate DB to simulate the shared-libs repository.
 *
 * Contains EmailValidator with sanitizeEmail → validateEmail transitive chain.
 */
export const IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED = [
  // ─── Library File node (1) ────────────────────────────────────────────
  `CREATE (f:File {id: 'file-EmailValidator_java', name: 'EmailValidator.java', filePath: 'EmailValidator.java', content: 'Email validation utility', repoId: 'shared-libs'})`,

  // ─── Library Method nodes (2) ─────────────────────────────────────────
  `CREATE (m:Method {id: 'method-validateEmail', name: 'validateEmail', filePath: 'EmailValidator.java', startLine: 10, endLine: 20, isExported: true, content: 'public boolean validateEmail(String email)', description: 'Validate email format', parameterCount: 1, returnType: 'boolean', parameters: '[String]', annotations: '[]', parameterAnnotations: '[]', repoId: 'shared-libs'})`,
  `CREATE (m:Method {id: 'method-sanitizeEmail', name: 'sanitizeEmail', filePath: 'EmailValidator.java', startLine: 25, endLine: 35, isExported: true, content: 'public String sanitizeEmail(String email)', description: 'Sanitize and normalize email', parameterCount: 1, returnType: 'String', parameters: '[String]', annotations: '[]', parameterAnnotations: '[]', repoId: 'shared-libs'})`,

  // ─── Library Class node (1) ───────────────────────────────────────────
  `CREATE (c:Class {id: 'class-EmailValidator', name: 'EmailValidator', filePath: 'EmailValidator.java', startLine: 1, endLine: 40, isExported: true, content: 'public class EmailValidator', description: 'Email validation utility class', fields: '[]', annotations: '[]', repoId: 'shared-libs'})`,

  // ─── Library HAS_METHOD edges: Class → Method (2) ─────────────────────
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-EmailValidator' AND m.id = 'method-validateEmail'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class-EmailValidator' AND m.id = 'method-sanitizeEmail'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,

  // ─── Library CALLS edge: Method → Method (transitive) ──────────────────
  // sanitizeEmail calls validateEmail (sanitize before validate)
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method-sanitizeEmail' AND b.id = 'method-validateEmail'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'direct-call', step: 0}]->(b)`,
];

/** FTS indexes for the cross-repo library DB (same schema as main). */
export const IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Route', indexName: 'route_fts', columns: ['name', 'httpMethod', 'routePath', 'controllerName', 'methodName'] },
];