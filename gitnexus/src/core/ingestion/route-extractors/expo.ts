// Expo Router route extraction utilities.
// Also handles Next.js App Router route.ts files when they appear in app/ directories.

export function expoFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // Skip TypeScript declaration files
  if (/\.d\.tsx?$/.test(normalized)) return null;

  // Must be inside an app/ directory
  const appMatch = normalized.match(/app\/(.+)\.(tsx?|jsx?)$/);
  if (!appMatch) return null;

  const segments = appMatch[1];
  const fileName = segments.split('/').pop() || '';

  // Skip layout files (_layout.tsx)
  if (fileName.startsWith('_')) return null;

  // Skip special Expo files (+not-found.tsx, +html.tsx) — but NOT +api files
  if (fileName.startsWith('+') && !fileName.startsWith('+api')) return null;

  // Handle Next.js App Router route handlers: route.ts, route.js
  // These define API routes at the directory level, so strip the /route suffix
  if (fileName === 'route') {
    // For app/api/grants/route.ts → segments = "api/grants/route" → "api/grants"
    const withoutRoute = segments.replace(/\/route$/, '');
    const route = '/' + stripRouteGroups(withoutRoute);
    return stripIndex(route);
  }

  // Handle Expo API routes: users+api.ts → /users
  if (fileName.endsWith('+api')) {
    const apiSegments = segments.replace(/\+api$/, '');
    const route = '/' + stripRouteGroups(apiSegments);
    return stripIndex(route);
  }

  // Regular screen route
  const route = '/' + stripRouteGroups(segments);
  return stripIndex(route);
}

function stripRouteGroups(path: string): string {
  return path.replace(/\([^)]+\)\/?/g, '');
}

function stripIndex(route: string): string {
  if (route === '/index') return '/';
  return route.replace(/\/index$/, '') || '/';
}
