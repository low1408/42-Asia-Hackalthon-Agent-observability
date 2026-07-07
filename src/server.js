import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServices } from "./services.js";
import { createMemoryStore, createPostgresStore } from "./postgresStore.js";
import { assertUserCan, httpError } from "./domain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

const API_ROUTES = [
  { method: "GET", path: "/api/bootstrap", auth: "user" },
  { method: "GET", path: "/api/metrics", auth: "user" },
  { method: "GET", path: "/api/observability/snapshot", auth: "user" },
  { method: "GET", path: "/api/observability/changes", auth: "user" },
  { method: "GET", path: "/api/health", auth: "public" },
  { method: "GET", path: "/api/workflow-runs", auth: "user" },
  { method: "POST", path: "/api/workflow-runs", auth: "user", permission: "create_workflow_run" },
  { method: "GET", path: "/api/workflow-runs/:workflowRunId", auth: "user" },
  { method: "POST", path: "/api/workflow-runs/:workflowRunId/agent-runs/simulate", auth: "user", permission: "create_workflow_run" },
  { method: "GET", path: "/api/workflow-runs/:workflowRunId/audit-trail", auth: "user", permission: "read_audit" },
  { method: "GET", path: "/api/workflow-runs/:workflowRunId/audit-export", auth: "user", permission: "read_audit" },
  { method: "GET", path: "/api/workflow-runs/:workflowRunId/delegation-map", auth: "user" },
  { method: "GET", path: "/api/work-items", auth: "user" },
  { method: "GET", path: "/api/work-items/:workItemId", auth: "user" },
  { method: "GET", path: "/api/agent-runs", auth: "user" },
  { method: "GET", path: "/api/agent-runs/:agentRunId", auth: "user" },
  { method: "POST", path: "/api/agent-runs/:agentRunId/progress", auth: "user", permission: "execute_tool_action" },
  { method: "POST", path: "/api/agent-runs/:agentRunId/complete", auth: "user", permission: "execute_tool_action" },
  { method: "POST", path: "/api/agents/:agentId/proposals", auth: "agent" },
  { method: "GET", path: "/api/approval-requests", auth: "user" },
  { method: "POST", path: "/api/approval-requests/:approvalRequestId/approve", auth: "user", permission: "approve", approvalParticipant: true },
  { method: "POST", path: "/api/approval-requests/:approvalRequestId/reject", auth: "user", permission: "reject", approvalParticipant: true },
  { method: "POST", path: "/api/tool-actions/:toolActionProposalId/execute", auth: "user", permission: "execute_tool_action" },
  { method: "GET", path: "/api/policy-rules", auth: "user" },
  { method: "PUT", path: "/api/policy-rules/:policyRuleId", auth: "user", permission: "update_policy" },
  { method: "GET", path: "/api/timeline", auth: "user" },
  { method: "GET", path: "/api/policy-checks", auth: "user" },
  { method: "GET", path: "/api/audit-events", auth: "user", permission: "read_audit" },
  { method: "GET", path: "/api/audit-events/verify", auth: "user", permission: "read_audit" },
  { method: "GET", path: "/api/artifacts", auth: "user" },
  { method: "POST", path: "/api/webhooks/events", auth: "public" }
];

function matchPath(pattern, pathname) {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(actual[index]);
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return params;
}

function matchApiRoute(method, pathname) {
  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { ...route, params };
  }
  return null;
}

function authorizeApiRoute({ req, route, services }) {
  if (route.auth === "public") return null;
  if (route.auth === "agent") return null;

  const actor = services.actorFromUserId(req.headers["x-user-id"]);
  if (route.permission) {
    assertUserCan(actor, route.permission);
  }

  if (route.approvalParticipant) {
    const approvalRequest = services.store.approvalRequests.find((request) => request.id === route.params.approvalRequestId);
    if (approvalRequest) {
      const required = approvalRequest.requiredApprovers.some((approver) => approver.userId === actor.id);
      const isAdmin = actor.roles.includes("admin");
      if (!required && !isAdmin) {
        throw httpError(403, "User is not a required approver for this request");
      }
    }
  }

  return actor;
}

export async function createDefaultServices() {
  const store = process.env.DATABASE_URL ? await createPostgresStore() : createMemoryStore();
  return createAppServices(store);
}

export function createServer({ services = createAppServices(createMemoryStore()) } = {}) {
  async function parseJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      const error = new Error("Invalid JSON body");
      error.status = 400;
      throw error;
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(body);
  }

  async function persistStore() {
    if (typeof services.store?.persist === "function") {
      await services.store.persist();
    }
  }

  async function sendStatic(req, res) {
    const url = new URL(req.url, "http://localhost");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = path.normalize(requested).replace(/^\.\.(\/|\\|$)/, "");
    const filePath = path.join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".js"
              ? "text/javascript; charset=utf-8"
              : "application/octet-stream";
      res.writeHead(200, { "content-type": contentType });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  function userFromHeaders(req) {
    return req.actor ?? services.actorFromUserId(req.headers["x-user-id"]);
  }

  async function routeApi(req, res) {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;
    const segments = url.pathname.split("/").filter(Boolean);
    const route = matchApiRoute(method, url.pathname);

    if (!route) {
      sendJson(res, 404, { error: "API route not found" });
      return;
    }

    req.actor = authorizeApiRoute({ req, route, services });

    if (method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(res, 200, services.bootstrap());
      return;
    }

    if (method === "GET" && url.pathname === "/api/observability/snapshot") {
      sendJson(res, 200, services.observabilitySnapshot());
      return;
    }

    if (method === "GET" && url.pathname === "/api/observability/changes") {
      const since = url.searchParams.get("since") || undefined;
      sendJson(res, 200, services.observabilityChanges(since));
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, services.healthCheck());
      return;
    }

    if (method === "GET" && url.pathname === "/api/metrics") {
      sendJson(res, 200, { metrics: services.dashboardMetrics() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/workflow-runs") {
      const since = url.searchParams.get("since") || undefined;
      sendJson(res, 200, { workflowRuns: services.listWorkflowRuns(since) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/work-items") {
      sendJson(res, 200, { workItems: services.listWorkItems(Object.fromEntries(url.searchParams.entries())) });
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "work-items" && segments.length === 3) {
      sendJson(res, 200, services.getWorkItem(segments[2]));
      return;
    }

    if (method === "GET" && url.pathname === "/api/agent-runs") {
      sendJson(res, 200, { agentRuns: services.listAgentRuns(Object.fromEntries(url.searchParams.entries())) });
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "agent-runs" && segments.length === 3) {
      sendJson(res, 200, services.getAgentRun(segments[2]));
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "agent-runs" && segments[3] === "progress") {
      const body = await parseJson(req);
      const payload = services.updateAgentRunProgress({
        agentRunId: segments[2],
        progress: body.progress,
        status: body.status,
        waitingOn: body.waitingOn
      });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "agent-runs" && segments[3] === "complete") {
      const body = await parseJson(req);
      const payload = services.completeAgentRun({ agentRunId: segments[2], autoSubmitProposal: body.autoSubmitProposal ?? false });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "POST" && url.pathname === "/api/workflow-runs") {
      const body = await parseJson(req);
      const actor = userFromHeaders(req);
      const payload = services.createWorkflowRun({ actor, source: body.source ?? "ui", title: body.title, request: body.request });
      await persistStore();
      sendJson(res, 201, payload);
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "workflow-runs" && segments.length === 3) {
      sendJson(res, 200, services.getWorkflowRun(segments[2]));
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "workflow-runs" && segments[3] === "agent-runs" && segments[4] === "simulate") {
      const payload = services.startAgentRunSimulation({ workflowRunId: segments[2] });
      await persistStore();
      sendJson(res, 202, payload);
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "workflow-runs" && segments[3] === "audit-trail") {
      const actor = userFromHeaders(req);
      sendJson(res, 200, { auditEvents: services.auditTrail({ actor, workflowRunId: segments[2] }) });
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "workflow-runs" && segments[3] === "audit-export") {
      const actor = userFromHeaders(req);
      const payload = services.auditExport({ actor, workflowRunId: segments[2] });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "workflow-runs" && segments[3] === "delegation-map") {
      sendJson(res, 200, services.getDelegationMap(segments[2]));
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "agents" && segments[3] === "proposals") {
      const body = await parseJson(req);
      const token = req.headers["x-agent-token"] || body.agentToken;
      const agent = services.agentFromId(segments[2], token);
      const payload = services.submitAgentProposal({
        agent,
        workflowRunId: body.workflowRunId,
        proposal: body.proposal
      });
      await persistStore();
      sendJson(res, 201, payload);
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "approval-requests" && segments[3] === "approve") {
      const body = await parseJson(req);
      const actor = userFromHeaders(req);
      const payload = services.applyApprovalDecision({
        actor,
        approvalRequestId: segments[2],
        decision: "approved",
        comment: body.comment,
        overrideReason: body.overrideReason
      });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/approval-requests") {
      sendJson(res, 200, { approvalRequests: services.listApprovalDashboard() });
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "approval-requests" && segments[3] === "reject") {
      const body = await parseJson(req);
      const actor = userFromHeaders(req);
      const payload = services.applyApprovalDecision({
        actor,
        approvalRequestId: segments[2],
        decision: "rejected",
        comment: body.comment,
        overrideReason: body.overrideReason
      });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "tool-actions" && segments[3] === "execute") {
      const actor = userFromHeaders(req);
      const payload = services.executeToolAction({ actor, toolActionProposalId: segments[2] });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/policy-rules") {
      sendJson(res, 200, { policyRules: services.store.policyRules });
      return;
    }

    if (method === "GET" && url.pathname === "/api/timeline") {
      const since = url.searchParams.get("since") || undefined;
      sendJson(res, 200, { timeline: services.listTimeline(since) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/policy-checks") {
      const since = url.searchParams.get("since") || undefined;
      sendJson(res, 200, { policyChecks: services.listPolicyChecks(since) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/audit-events") {
      sendJson(res, 200, { auditEvents: services.store.auditEvents });
      return;
    }

    if (method === "GET" && url.pathname === "/api/audit-events/verify") {
      sendJson(res, 200, services.validateAllAuditHashChains());
      return;
    }

    if (method === "GET" && url.pathname === "/api/artifacts") {
      const since = url.searchParams.get("since") || undefined;
      sendJson(res, 200, { artifacts: services.listArtifacts(since) });
      return;
    }

    if (method === "PUT" && segments[0] === "api" && segments[1] === "policy-rules" && segments.length === 3) {
      const body = await parseJson(req);
      const actor = userFromHeaders(req);
      const payload = services.updatePolicyRule({ actor, ruleId: segments[2], patch: body });
      await persistStore();
      sendJson(res, 200, payload);
      return;
    }

    if (method === "POST" && url.pathname === "/api/webhooks/events") {
      const body = await parseJson(req);
      const payload = services.receiveWebhookEvent({
        source: body.source ?? "webhook",
        eventType: body.eventType,
        payload: body.payload ?? {}
      });
      await persistStore();
      sendJson(res, 202, payload);
      return;
    }

    sendJson(res, 404, { error: "API route not found" });
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/")) {
        await routeApi(req, res);
        return;
      }
      await sendStatic(req, res);
    } catch (error) {
      sendJson(res, error.status ?? 500, {
        error: error.message,
        details: error.details
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3010);
  const services = await createDefaultServices();
  createServer({ services }).listen(port, () => {
    const storage = services.store.storage?.type ?? "memory";
    console.log(`Enterprise Agent-Human Collaboration Layer listening on http://localhost:${port} using ${storage} storage`);
  });
}
