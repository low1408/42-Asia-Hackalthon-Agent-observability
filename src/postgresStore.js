import { Pool } from "pg";
import { createSeedStore } from "./store.js";

const DEFAULT_STATE_ID = "default";

function mergeWithCurrentShape(saved) {
  const base = createSeedStore();
  if (!saved || typeof saved !== "object") return base;

  return {
    ...base,
    ...saved,
    workspaces: saved.workspaces ?? base.workspaces,
    users: saved.users ?? base.users,
    agents: saved.agents ?? base.agents,
    toolConnectors: saved.toolConnectors ?? base.toolConnectors,
    workflowDefinitions: saved.workflowDefinitions ?? base.workflowDefinitions,
    policyRules: saved.policyRules ?? base.policyRules,
    workflowRuns: saved.workflowRuns ?? [],
    tasks: saved.tasks ?? [],
    approvalRequests: saved.approvalRequests ?? [],
    toolActionProposals: saved.toolActionProposals ?? [],
    agentRuns: saved.agentRuns ?? [],
    policyChecks: saved.policyChecks ?? [],
    auditEvents: saved.auditEvents ?? [],
    evidenceArtifacts: saved.evidenceArtifacts ?? [],
    purchaseRequests: saved.purchaseRequests ?? [],
    tickets: saved.tickets ?? []
  };
}

function attachPersistence(store, { pool, stateId }) {
  async function persist() {
    await pool.query(
      `INSERT INTO enterprise_dashboard_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [stateId, JSON.stringify(store)]
    );
  }

  Object.defineProperties(store, {
    persist: { value: persist, enumerable: false },
    close: { value: () => pool.end(), enumerable: false },
    storage: { value: { type: "postgres", stateId }, enumerable: false }
  });

  return store;
}

export async function createPostgresStore({
  connectionString = process.env.DATABASE_URL,
  stateId = process.env.DASHBOARD_STATE_ID ?? DEFAULT_STATE_ID,
  reset = process.env.RESET_DASHBOARD_DATA === "true"
} = {}) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to initialize the Postgres store");
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS enterprise_dashboard_state (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  if (reset) {
    await pool.query("DELETE FROM enterprise_dashboard_state WHERE id = $1", [stateId]);
  }

  const result = await pool.query("SELECT data FROM enterprise_dashboard_state WHERE id = $1", [stateId]);
  const store = mergeWithCurrentShape(result.rows[0]?.data);
  const persistentStore = attachPersistence(store, { pool, stateId });

  if (!result.rowCount || reset) {
    await persistentStore.persist();
  }

  return persistentStore;
}

export function createMemoryStore() {
  const store = createSeedStore();
  Object.defineProperty(store, "storage", { value: { type: "memory" }, enumerable: false });
  return store;
}
