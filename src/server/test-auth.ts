import { readDaemonSecret } from "./control-server.js";

/**
 * Shared auth header for dashboard integration tests.
 *
 * `createDashboardServer()` calls `ensureDaemonSecret()` on startup, which
 * writes/reads `$HOME/.formiga/daemon-secret`. Tests must call this AFTER the
 * server is up so the file exists and matches what the server enforces
 * (CR-1: mutating /api/* routes require the daemon secret).
 *
 * NOTE: this helper is imported from the source module (not dist) so the
 * tsconfig build (which only excludes `*.test.ts`, not this file) never pulls
 * `dist/server/*.d.ts` into the program as inputs.
 */
export function daemonAuthHeaders(): Record<string, string> {
  const secret = readDaemonSecret();
  return secret ? { "x-formiga-secret": secret } : {};
}
