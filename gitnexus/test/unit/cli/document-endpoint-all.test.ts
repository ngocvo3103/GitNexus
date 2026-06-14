/**
 * Unit Tests: document-endpoint --all batch mode
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to share state between the mock factory (run at module load)
// and the test code (run after all imports)
const { mockBackendInstance } = vi.hoisted(() => {
  const backend = {
    init: vi.fn().mockResolvedValue(true),
    resolveRepo: vi.fn().mockResolvedValue({ id: 'test-repo', name: 'test-repo', repoPath: '/test', storagePath: '/test/storage', lbugPath: '/test/lbug', indexedAt: '2024-01-01', lastCommit: 'abc' }),
    callTool: vi.fn(),
  };
  return { mockBackendInstance: backend };
});

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join('/')),
    resolve: vi.fn((...args: string[]) => args.join('/').replace(/^([a-z]:)/i, '$1/')),
  },
  join: vi.fn((...args: string[]) => args.join('/')),
  resolve: vi.fn((...args: string[]) => args.join('/').replace(/^([a-z]:)/i, '$1/')),
}));

// Mock LocalBackend constructor to return our mock instance
vi.mock('../../../src/mcp/local/local-backend.js', () => {
  function MockLocalBackend() {
    return mockBackendInstance;
  }
  return { LocalBackend: MockLocalBackend };
});

vi.mock('../../../src/cli/heap-utils.js', () => ({
  ensureHeap: vi.fn().mockReturnValue(false),
}));

import { documentEndpointCommand, resetBackendForTesting } from '../../../src/cli/tool.js';
import fs from 'node:fs';

describe('document-endpoint --all batch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackendForTesting();

    mockBackendInstance.init.mockResolvedValue(true);
    mockBackendInstance.resolveRepo.mockResolvedValue({
      id: 'test-repo', name: 'test-repo', repoPath: '/test', storagePath: '/test/storage',
      lbugPath: '/test/lbug', indexedAt: '2024-01-01', lastCommit: 'abc'
    });
    mockBackendInstance.callTool.mockReset();
  });

  // ── 1. init() returns false → exit 1 ─────────────────────────────────
  it('init() returns false → exit 1', async () => {
    mockBackendInstance.init.mockResolvedValueOnce(false);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    mockExit.mockRestore();
  });

  // ── 2. resolveRepo() returns null → exit 1, "not found" ─────────────────
  it('resolveRepo() returns null → exit 1, "not found"', async () => {
    mockBackendInstance.resolveRepo.mockResolvedValueOnce(null);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not found'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 3. endpoints query throws → error propagates ──
  it('endpoints query throws → error propagates', async () => {
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.reject(new Error('query failed'));
      return Promise.resolve({ result: { yaml: '' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    // The command doesn't try/catch the endpoints query, so the error propagates
    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('query failed');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  // ── 4. Empty results → exit 0, no files written, "No endpoints" ────────
  it('empty results → exit 0, no files written, "No endpoints" message', async () => {
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints: [] });
      return Promise.resolve({ result: { yaml: '' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(0)');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('No endpoints'));
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 5. All 3 routes succeed → 3 files written, progress logged, exit 0 ─
  it('all 3 routes succeed → 3 files written, progress logged, exit 0', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/users' },
      { method: 'POST', path: '/api/users' },
      { method: 'DELETE', path: '/api/users/{id}' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      return Promise.resolve({ result: { yaml: 'openapi: 3.0.0\ninfo:\n  title: API' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(0)');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Written:'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 6. Route 2 of 3 throws → routes 1 and 3 written, warning, exit 1 ────
  it('route 2 of 3 throws → routes 1 and 3 written, warning logged, exit 1', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/users' },
      { method: 'POST', path: '/api/bad' },
      { method: 'DELETE', path: '/api/users/{id}' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string, params: any) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      // Route 2 (POST /api/bad) throws
      if (params?.path === '/api/bad') return Promise.reject(new Error('tool failed'));
      return Promise.resolve({ result: { yaml: 'openapi: 3.0.0' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 7. All routes fail → no files, N warnings, exit 1 ───────────────────
  it('all routes fail → no files, N warnings, exit 1', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/bad1' },
      { method: 'POST', path: '/api/bad2' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string, params: any) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      return Promise.reject(new Error('tool failed'));
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 8. Filename sanitization: GET /api/bonds/{id}/details ────────────────
  it('filename sanitization: GET /api/bonds/{id}/details → GET_api_bonds_id_details.openapi.yaml', async () => {
    const endpoints = [{ method: 'GET', path: '/api/bonds/{id}/details' }];
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      return Promise.resolve({ result: { yaml: 'openapi: 3.0.0' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const writtenPaths: string[] = [];
    (fs.writeFileSync as any).mockImplementation((p: string) => writtenPaths.push(p));

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(0)');
    expect(writtenPaths[0]).toMatch(/GET_api_bonds_id_details\.openapi\.yaml$/);
    mockExit.mockRestore();
  });

  // ── 9. --all + --method → exit 1, "mutually exclusive" ────────────────────
  it('--all + --method → exit 1, cannot be used with', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, method: 'GET', outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--all cannot be used with'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 10. Error field propagates specific message ────────────────────────
  it('error field from documentEndpoint propagates specific message', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/bad' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string, params: any) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      // Return error result shape (no yaml field)
      return Promise.resolve({ result: { method: 'GET', path: '/api/bad' }, error: 'No handler found for GET /api/bad' });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    // The specific error message should appear in the error output, not the generic one
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('No handler found for GET /api/bad'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 11. --allow-partial: partial success → exit 0 ─────────────────────
  it('--allow-partial: partial success → exit 0', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/good' },
      { method: 'POST', path: '/api/bad' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string, params: any) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      if (params?.path === '/api/bad') return Promise.reject(new Error('tool failed'));
      return Promise.resolve({ result: { yaml: 'openapi: 3.0.0' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out', allowPartial: true })).rejects.toThrow('process.exit(0)');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 12. --allow-partial: all fail → exit 1 ──────────────────────────────
  it('--allow-partial: all fail → exit 1', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/bad1' },
      { method: 'POST', path: '/api/bad2' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      return Promise.reject(new Error('tool failed'));
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out', allowPartial: true })).rejects.toThrow('process.exit(1)');
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 13. No --allow-partial (default): partial success → exit 1 ──────────
  it('no --allow-partial (default): partial success → exit 1', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/good' },
      { method: 'POST', path: '/api/bad' },
    ];
    mockBackendInstance.callTool.mockImplementation((method: string, params: any) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      if (params?.path === '/api/bad') return Promise.reject(new Error('tool failed'));
      return Promise.resolve({ result: { yaml: 'openapi: 3.0.0' } });
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 14. Result lacks yaml field and no error field → generic error ─────
  it('throws generic error when result lacks yaml field and no error field', async () => {
    const endpoints = [{ method: 'GET', path: '/api/test' }];
    mockBackendInstance.callTool.mockImplementation((method: string) => {
      if (method === 'endpoints') return Promise.resolve({ endpoints });
      return Promise.resolve({ result: { method: 'GET', path: '/api/test' } }); // no yaml, no error
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Expected OpenAPI YAML output'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  // ── 15. --all + --input-yaml → exit 1, incompatible ────────────────────
  it('--all + --input-yaml → exit 1, incompatible', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(documentEndpointCommand({ all: true, inputYaml: '/some/file.yaml', outputPath: '/tmp/out' })).rejects.toThrow('process.exit(1)');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('incompatible'));
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });
});