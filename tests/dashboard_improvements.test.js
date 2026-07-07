import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createSeedStore } from "../src/store.js";
import { createAppServices } from "../src/services.js";
import { createServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.resolve(__dirname, "../public/app.js");

function createHarness() {
  const store = createSeedStore();
  const services = createAppServices(store);
  return {
    store,
    services,
    requester: services.actorFromUserId("usr_requester"),
    operator: services.actorFromUserId("usr_operator"),
    agent: services.agentFromId("agt_procurement_triage", "demo-agent-token")
  };
}

function createRun(services, actor, overrides = {}) {
  return services.createWorkflowRun({
    actor,
    source: "ui",
    title: "Test procurement request",
    request: {
      vendor: "Atlas Cloud",
      amount: 12500,
      currency: "USD",
      category: "software",
      department: "Operations",
      businessJustification: "Need software for onboarding",
      vendorRisk: "high",
      ...overrides
    }
  });
}

function submitProposal(services, agent, run, overrides = {}) {
  return services.submitAgentProposal({
    agent,
    workflowRunId: run.id,
    proposal: {
      actionType: "create_purchase_request",
      connectorId: "tool_procurement_record",
      summary: "Create a governed purchase request after approval.",
      extractedFields: run.request,
      confidence: 0.91,
      ...overrides
    }
  });
}

async function runAppJs(sandbox) {
  let code = await fs.readFile(appJsPath, "utf8");
  
  // Replace top-level const declarations with window assignments so the test suite can read and write them
  code = code.replace("const state =", "window.state =");
  code = code.replace("const el =", "window.el =");
  
  // Bind standard variables and functions
  sandbox.console = sandbox.console || { log: console.log, warn: console.warn, error: () => {} };
  sandbox.setInterval = sandbox.setInterval || (() => {});
  sandbox.setTimeout = sandbox.setTimeout || (() => {});
  sandbox.Promise = sandbox.Promise || Promise;
  sandbox.Array = sandbox.Array || Array;
  sandbox.Object = sandbox.Object || Object;
  sandbox.Error = sandbox.Error || Error;
  sandbox.Number = sandbox.Number || Number;
  sandbox.String = sandbox.String || String;
  sandbox.Date = sandbox.Date || Date;
  sandbox.Math = sandbox.Math || Math;
  sandbox.RegExp = sandbox.RegExp || RegExp;
  sandbox.JSON = sandbox.JSON || JSON;
  sandbox.FormData = sandbox.FormData || class {};
  
  // Bind standard document and window mocks if not provided
  sandbox.document = sandbox.document || {};
  sandbox.document.body = sandbox.document.body || { innerHTML: "" };
  sandbox.document.querySelector = sandbox.document.querySelector || ((sel) => {
    return { innerHTML: "", className: "", addEventListener: () => {}, textContent: "" };
  });
  sandbox.document.querySelectorAll = sandbox.document.querySelectorAll || (() => []);
  sandbox.document.getElementById = sandbox.document.getElementById || (() => ({ addEventListener: () => {} }));
  
  sandbox.location = sandbox.location || { hash: "", reload: () => {} };
  
  // Bind fetch if not provided
  sandbox.fetch = sandbox.fetch || (async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => h.toLowerCase() === "content-type" ? "application/json" : null
    },
    json: async () => ({
      users: [],
      agents: [],
      dashboard: { agentRuns: [], metrics: [], workItems: [], timeline: [], policyAudit: { summary: {}, checks: [] }, artifacts: [] },
      workflowRuns: []
    })
  }));
  
  // Bind window and basic event listener to prevent ReferenceErrors
  sandbox.window = sandbox;
  sandbox.addEventListener = sandbox.addEventListener || (() => {});
  
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
}

test("Route Coverage Test - pageForRoute() handles all sidebar and navigation links", async () => {
  const htmlPath = path.resolve(__dirname, "../public/index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  
  // Extract all data-route="..." strings
  const routes = [...html.matchAll(/data-route="([^"]+)"/g)].map(m => m[1]);
  assert.ok(routes.length > 0, "Should find data-route attributes in HTML");

  const sandbox = {
    location: { hash: "" },
    document: {
      querySelector: () => ({ innerHTML: "", addEventListener: () => {} }),
      querySelectorAll: () => []
    }
  };
  await runAppJs(sandbox);

  for (const route of routes) {
    const page = sandbox.pageForRoute(route);
    assert.ok(page, `Route "${route}" should return a valid page`);
    if (route !== "home") {
      assert.notEqual(page, "home", `Route "${route}" should not fall back to home`);
    } else {
      assert.equal(page, "home", `Route "home" should return "home"`);
    }
  }
});

test("Duplicate Route Check - ensure unique labels in sidebar have unique routing targets", async () => {
  const htmlPath = path.resolve(__dirname, "../public/index.html");
  const html = await fs.readFile(htmlPath, "utf8");

  const sideNavBlock = html.split('<nav class="side-nav"')[1].split('</nav>')[0];
  const links = [...sideNavBlock.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  const labels = [...sideNavBlock.matchAll(/>([^<]+)<\/a>/g)].map(m => m[1].trim());

  const labelToHash = {};
  for (let i = 0; i < links.length; i++) {
    const label = labels[i];
    const hash = links[i];
    if (labelToHash[label]) {
      assert.equal(labelToHash[label], hash, `Label "${label}" is duplicated with different hashes`);
    } else {
      for (const [existingLabel, existingHash] of Object.entries(labelToHash)) {
        assert.ok(existingHash !== hash, `Hash "${hash}" is mapped to both "${existingLabel}" and "${label}"`);
      }
      labelToHash[label] = hash;
    }
  }
});

test("API Error Handling - hardened api client parses correctly and throws clean errors on 502/204", async () => {
  const sandboxHtml = {
    location: { hash: "" },
    document: {
      querySelector: () => ({ innerHTML: "", addEventListener: () => {} }),
      querySelectorAll: () => []
    }
  };
  
  // Test 502 HTML Bad Gateway Response
  sandboxHtml.fetch = async () => ({
    ok: false,
    status: 502,
    headers: {
      get: (h) => h.toLowerCase() === "content-type" ? "text/html" : null
    },
    text: async () => "502 Bad Gateway HTML"
  });
  await runAppJs(sandboxHtml);

  await assert.rejects(
    () => sandboxHtml.api("/api/test"),
    /502 Bad Gateway/
  );

  // Test 204 No Content Response
  const sandboxEmpty = {
    location: { hash: "" },
    document: {
      querySelector: () => ({ innerHTML: "", addEventListener: () => {} }),
      querySelectorAll: () => []
    },
    fetch: async () => ({
      ok: true,
      status: 204,
      headers: {
        get: (h) => h.toLowerCase() === "content-type" ? "application/json" : null
      }
    })
  };
  await runAppJs(sandboxEmpty);

  const res = await sandboxEmpty.api("/api/test");
  assert.equal(res, null, "204 No Content should return null");
});

test("Data Freshness Test - status indicator transitions to offline/degraded after failures", async () => {
  const systemStatusEl = { className: "", innerHTML: "" };
  const appEl = { innerHTML: "", addEventListener: () => {} };
  const sandbox = {
    location: { hash: "", reload: () => {} },
    document: {
      querySelector: (sel) => {
        if (sel === "#systemStatus") return systemStatusEl;
        if (sel === "#app") return appEl;
        return { innerHTML: "", addEventListener: () => {} };
      },
      querySelectorAll: () => []
    },
    fetch: async () => {
      if (!sandbox.state || !sandbox.state.lastLoadedAt) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            users: [],
            agents: [],
            dashboard: { agentRuns: [], metrics: [], workItems: [], timeline: [], policyAudit: { summary: {}, checks: [] }, artifacts: [] },
            workflowRuns: []
          })
        };
      }
      throw new Error("Simulated Connection Timeout");
    }
  };
  await runAppJs(sandbox);

  // Initial load
  await sandbox.load();
  assert.equal(sandbox.state.pollErrorCount, 0);
  assert.ok(sandbox.state.lastLoadedAt);
  assert.match(systemStatusEl.innerHTML, /All systems operational/);

  // Failure 1
  await sandbox.pollUpdate();
  assert.equal(sandbox.state.pollErrorCount, 1);
  assert.match(systemStatusEl.innerHTML, /Connection offline/);

  // Failure 2
  await sandbox.pollUpdate();
  assert.equal(sandbox.state.pollErrorCount, 2);

  // Failure 3
  await sandbox.pollUpdate();
  assert.equal(sandbox.state.pollErrorCount, 3);
  assert.match(systemStatusEl.innerHTML, /Connection offline \(3 failures\)/);
});

test("Direct RBAC Injection - Validate backend auth boundaries on execute endpoint", async () => {
  const { services } = createHarness();
  const server = createServer({ services });

  const requester = services.actorFromUserId("usr_requester");
  const agent = services.agentFromId("agt_procurement_triage", "demo-agent-token");
  let run = createRun(services, requester);
  run = submitProposal(services, agent, run);
  const proposalId = run.toolActionProposals[0].id;

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tool-actions/${proposalId}/execute`, {
      method: "POST",
      headers: {
        "x-user-id": "usr_requester",
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(res.status, 403, "Low-privilege user execution should return 403 Forbidden");
    const json = await res.json();
    assert.match(json.error, /not allowed to execute_tool_action/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Authentication hardening requires explicit user identity but leaves health public", async () => {
  const { services } = createHarness();
  const server = createServer({ services });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const bootstrapRes = await fetch(`http://localhost:${port}/api/bootstrap`);
    assert.equal(bootstrapRes.status, 401, "Missing x-user-id should not default to admin");

    const healthRes = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(healthRes.status, 200, "Health endpoint should be public for infrastructure checks");
    const health = await healthRes.json();
    assert.equal(health.status, "healthy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Audit verification endpoint detects tampered audit events and health degradation", async () => {
  const { services, requester } = createHarness();
  createRun(services, requester);
  const server = createServer({ services });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    let verifyRes = await fetch(`http://localhost:${port}/api/audit-events/verify`, {
      headers: { "x-user-id": "usr_admin" }
    });
    assert.equal(verifyRes.status, 200);
    let verification = await verifyRes.json();
    assert.equal(verification.valid, true);

    services.store.auditEvents[0].summary = "tampered after hashing";

    verifyRes = await fetch(`http://localhost:${port}/api/audit-events/verify`, {
      headers: { "x-user-id": "usr_admin" }
    });
    verification = await verifyRes.json();
    assert.equal(verification.valid, false);
    assert.equal(verification.failedChainCount, 1);

    const healthRes = await fetch(`http://localhost:${port}/api/health`);
    const health = await healthRes.json();
    assert.equal(health.status, "degraded");
    assert.equal(health.audit.valid, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Observability snapshot and changes use server-issued cursors", async () => {
  const { services, requester } = createHarness();
  const server = createServer({ services });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const snapshotRes = await fetch(`http://localhost:${port}/api/observability/snapshot`, {
      headers: { "x-user-id": "usr_admin" }
    });
    assert.equal(snapshotRes.status, 200);
    const snapshot = await snapshotRes.json();
    assert.ok(snapshot.cursor, "Snapshot should return a cursor");

    const run = createRun(services, requester, { vendor: "CursorCo", amount: 2500 });

    const changesRes = await fetch(`http://localhost:${port}/api/observability/changes?since=${encodeURIComponent(snapshot.cursor)}`, {
      headers: { "x-user-id": "usr_admin" }
    });
    assert.equal(changesRes.status, 200);
    const changes = await changesRes.json();
    assert.ok(changes.cursor, "Changes response should return the next cursor");
    assert.equal(changes.changes.workflowRuns.some((entry) => entry.id === run.id), true);
    assert.ok(Array.isArray(changes.dashboard.metrics));
    assert.ok(changes.dashboard.analytics);

    const missingCursorRes = await fetch(`http://localhost:${port}/api/observability/changes`, {
      headers: { "x-user-id": "usr_admin" }
    });
    assert.equal(missingCursorRes.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
