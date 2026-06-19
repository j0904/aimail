// Ephemeral Postgres harness for e2e tests.
//
// Spins up a fresh, isolated postgres:16-alpine container per test run on a
// random high port, yields a ready `pg.Pool`, and tears it down in `stop()`
// (best-effort even on failure). This is the only thing in the e2e suite that
// touches docker; the rest of the tests talk to it over plain SQL.
//
// Requires docker on PATH and a runnable daemon. If absent, the harness throws
// a clear error so the test runner can mark the suite skipped rather than fail.

import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export interface PostgresHarness {
  /** pg.Pool connected to the ephemeral database. */
  pool: pg.Pool;
  /** Connection config (host/port/user/password/database). */
  config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** Stop the container and free the port. Safe to call once. */
  stop(): Promise<void>;
}

const DOCKER_IMAGE = 'postgres:16-alpine';

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Pick a free TCP port by binding to :0 and reading the assigned port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // node:net server trick — import lazily so the unit test runs don't pull it.
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
    });
  });
}

/**
 * Start an ephemeral postgres container and wait until it accepts connections.
 * Throws if docker is unavailable.
 */
export async function startPostgres(): Promise<PostgresHarness> {
  if (!dockerAvailable()) {
    throw new Error(
      'docker is not available on PATH or the daemon is not running; ' +
        'cannot run the DB-backed e2e suite. Install/start docker, or run ' +
        '`npm test` for the Postgres-free unit/integration suite.',
    );
  }

  // Pull image quietly up-front so the run doesn't fail on a missing image.
  try {
    execSync(`docker pull ${DOCKER_IMAGE}`, { stdio: 'ignore' });
  } catch {
    // Non-fatal: image may already be present (offline). The run will fail
    // with a clearer error if not.
  }

  const port = await freePort();
  const password = randomUUID();
  const database = 'aimail';
  const user = 'postgres';
  const containerName = `aimail-e2e-${randomUUID().slice(0, 8)}`;

  // Detached container. We capture stdout for diagnostics on failure.
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      containerName,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      `${port}:5432`,
      DOCKER_IMAGE,
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();

  const config = { host: '127.0.0.1', port, user, password, database };

  // Wait for postgres to accept connections (up to ~30s).
  const ready = await waitForPostgres(config, 30_000);
  if (!ready) {
    await stopContainer(containerName);
    throw new Error(
      `postgres container ${containerName} did not become ready on port ${port} within 30s`,
    );
  }

  const pool = new pg.Pool({ ...config, max: 5 });

  return {
    pool,
    config,
    async stop() {
      await pool.end();
      await stopContainer(containerName);
    },
  };
}

async function waitForPostgres(
  config: { host: string; port: number; user: string; password: string; database: string },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch {
      // not ready yet
    } finally {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function stopContainer(name: string): Promise<void> {
  return new Promise((resolve) => {
    execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
    resolve();
  });
}
