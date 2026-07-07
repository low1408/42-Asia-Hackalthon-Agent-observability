import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServices } from "./services.js";
import { createMemoryStore, createPostgresStore } from "./postgresStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

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
    return services.actorFromUserId(req.headers["x-user-id"] || "usr_admin");
  }

  async function routeApi(req, res) {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;
    const segments = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(res, 200, services.bootstrap());
      return;
    }

    if (method === "GET" && url.pathname === "/api/workflow-runs") {
      sendJson(res, 200, { workflowRuns: services.listWorkflowRuns() });
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
      sendJson(res, 200, { timeline: services.listTimeline() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/policy-checks") {
      sendJson(res, 200, { policyChecks: services.listPolicyChecks() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/audit-events") {
      sendJson(res, 200, { auditEvents: services.store.auditEvents });
      return;
    }

    if (method === "GET" && url.pathname === "/api/artifacts") {
      sendJson(res, 200, { artifacts: services.listArtifacts() });
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
