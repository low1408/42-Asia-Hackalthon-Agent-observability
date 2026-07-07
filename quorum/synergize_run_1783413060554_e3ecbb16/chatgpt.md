# Council Member Report — chatgpt

Run ID: synergize_run_1783413060554_e3ecbb16

## Proposed Solution


Add a **Productivity Command Center** layer on top of the existing observability dashboard. The best extension is not a random set of widgets; it should directly reduce operator latency in the current workflow: agent proposal → policy check → approval → tool execution → audit.


Implement four features:


1. **Operator Inbox**


* A unified queue of pending approvals, approved tool actions ready for execution, blocked runs, and stale agent runs.
* Sorted by urgency and risk.
* Gives humans one place to decide “what needs action now?”
2. **Run Brief / Decision Summary**


* A compact, generated summary for each workflow run.
* Includes request facts, proposal, policy outcome, required approvers, risks, due time, and recommended next human action.
* No LLM required; deterministic summary is enough for MVP.
3. **SLA / Bottleneck Analytics**


* Dashboard metrics for overdue approvals, time waiting on humans, time waiting on agents, approval throughput, and blocked-rate.
* Helps managers see whether productivity is constrained by policy, humans, agents, or tools.
4. **Human-Agent Notes and Handoff Comments**


* Threaded comments on workflow runs, approval requests, and tool proposals.
* Lets approvers ask agents/operators for clarification without leaving the dashboard.
* Every note should be audit-logged.



This fits the current architecture: state lives in `store.js`, APIs are in `server.js`, business logic in `services.js`, and persistence serializes the whole store document. No separate queue, worker, or event bus is needed for the first version.


## Implementation Details


### 1. Extend domain permissions


Add collaboration permissions in `src/domain.js`.


```
export const COLLABORATION_TARGET_TYPES = Object.freeze({
  WORKFLOW_RUN: "workflow_run",
  APPROVAL_REQUEST: "approval_request",
  TOOL_ACTION_PROPOSAL: "tool_action_proposal",
  AGENT_RUN: "agent_run"
});
```


Extend `assertUserCan` grants:


```
const grants = {
  create_workflow_run: [ROLES.REQUESTER, ROLES.OPERATOR, ROLES.ADMIN],
  approve: [ROLES.APPROVER, ROLES.ADMIN],
  reject: [ROLES.APPROVER, ROLES.ADMIN],
  execute_tool_action: [ROLES.OPERATOR, ROLES.ADMIN],
  read_audit: [ROLES.AUDITOR, ROLES.ADMIN, ROLES.OPERATOR],
  update_policy: [ROLES.ADMIN],
  read_admin: [ROLES.ADMIN],
  override_approval: [ROLES.ADMIN],

  read_productivity: [
    ROLES.REQUESTER,
    ROLES.APPROVER,
    ROLES.OPERATOR,
    ROLES.AUDITOR,
    ROLES.ADMIN
  ],
  create_note: [
    ROLES.REQUESTER,
    ROLES.APPROVER,
    ROLES.OPERATOR,
    ROLES.ADMIN
  ]
};
```


### 2. Add store collections


Assumption: `store.js` owns the initial mock structure, but it was not included. Add these arrays to the initial store object:


```
collaborationNotes: [],
savedViews: []
```


For Postgres persistence, no schema change should be needed if the app already serializes the whole dashboard state as one JSONB document.


### 3. Add productivity service methods


Add these functions inside `createAppServices(store)` in `src/services.js`.


#### Helper functions


```
function ageMinutes(iso) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function isOverdue(iso) {
  return Boolean(iso) && new Date(iso).getTime() < Date.now();
}

function riskRank(risk) {
  const ranks = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };
  return ranks[String(risk ?? "unknown").toLowerCase()] ?? 0;
}

function urgencyRank(item) {
  let score = 0;
  if (item.overdue) score += 100;
  if (item.kind === "approval") score += 40;
  if (item.kind === "tool_execution") score += 35;
  if (item.kind === "blocked_run") score += 30;
  if (item.kind === "stale_agent") score += 20;
  score += riskRank(item.risk) * 10;
  score += Math.min(30, Math.floor((item.ageMinutes ?? 0) / 30));
  return score;
}
```


#### Operator Inbox


```
function listOperatorInbox({ actor, assigneeUserId = actor.id } = {}) {
  assertUserCan(actor, "read_productivity");

  const approvalItems = store.approvalRequests
    .filter((approval) => approval.status === APPROVAL_STATUS.PENDING)
    .filter((approval) =>
      actor.roles.includes("admin") ||
      approval.requiredApprovers.some((approver) => approver.userId === assigneeUserId)
    )
    .map((approval) => {
      const run = findById(store.workflowRuns, approval.workflowRunId, "WorkflowRun");
      const proposal = store.toolActionProposals.find((entry) => entry.id === approval.toolActionProposalId);
      return {
        id: `inbox_${approval.id}`,
        kind: "approval",
        title: `Approve ${run.title}`,
        workflowRunId: run.id,
        approvalRequestId: approval.id,
        toolActionProposalId: proposal?.id ?? null,
        status: approval.status,
        risk: run.request?.vendorRisk ?? "unknown",
        dueAt: approval.dueAt,
        overdue: isOverdue(approval.dueAt),
        ageMinutes: ageMinutes(approval.createdAt),
        nextAction: "Review proposal and approve or reject",
        summary: proposal?.summary ?? "Approval required"
      };
    });

  const executionItems = store.toolActionProposals
    .filter((proposal) => proposal.status === TOOL_ACTION_STATUS.APPROVED)
    .map((proposal) => {
      const run = findById(store.workflowRuns, proposal.workflowRunId, "WorkflowRun");
      return {
        id: `inbox_${proposal.id}`,
        kind: "tool_execution",
        title: `Execute ${proposal.actionType} for ${run.title}`,
        workflowRunId: run.id,
        toolActionProposalId: proposal.id,
        status: proposal.status,
        risk: run.request?.vendorRisk ?? "unknown",
        dueAt: null,
        overdue: false,
        ageMinutes: ageMinutes(proposal.updatedAt),
        nextAction: "Execute approved tool action",
        summary: proposal.summary
      };
    });

  const blockedItems = store.workflowRuns
    .filter((run) => run.status === WORKFLOW_STATUS.BLOCKED)
    .map((run) => {
      const latestCheck = [...store.policyChecks]
        .filter((check) => check.workflowRunId === run.id)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];

      return {
        id: `inbox_${run.id}`,
        kind: "blocked_run",
        title: `Resolve blocked workflow: ${run.title}`,
        workflowRunId: run.id,
        status: run.status,
        risk: run.request?.vendorRisk ?? "unknown",
        dueAt: null,
        overdue: false,
        ageMinutes: ageMinutes(run.updatedAt),
        nextAction: "Review blocking policy result",
        summary: latestCheck?.summary ?? "Workflow is blocked"
      };
    });

  const staleAgentItems = store.agentRuns
    .filter((run) => run.status === "running" && ageMinutes(run.updatedAt) >= 60)
    .map((agentRun) => {
      const run = findById(store.workflowRuns, agentRun.workflowRunId, "WorkflowRun");
      return {
        id: `inbox_${agentRun.id}`,
        kind: "stale_agent",
        title: `Check stalled agent: ${agentRun.agentName}`,
        workflowRunId: run.id,
        agentRunId: agentRun.id,
        status: agentRun.status,
        risk: run.request?.vendorRisk ?? "unknown",
        dueAt: null,
        overdue: false,
        ageMinutes: ageMinutes(agentRun.updatedAt),
        nextAction: "Inspect agent run or restart simulation",
        summary: agentRun.waitingOn
          ? `${agentRun.agentName} is waiting on ${agentRun.waitingOn}`
          : `${agentRun.agentName} has not updated recently`
      };
    });

  return [...approvalItems, ...executionItems, ...blockedItems, ...staleAgentItems]
    .map((item) => ({ ...item, urgencyScore: urgencyRank(item) }))
    .sort((a, b) => b.urgencyScore - a.urgencyScore);
}
```


#### Run Brief


```
function getRunBrief({ actor, workflowRunId }) {
  assertUserCan(actor, "read_productivity");

  const run = getWorkflowRun(workflowRunId);
  const latestProposal = [...run.toolActionProposals].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];

  const latestApproval = [...run.approvalRequests].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];

  const latestPolicyCheck = [...run.policyChecks].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt)
  )[0];

  const openTasks = run.tasks.filter((task) => task.status === "open");

  let recommendedAction = "Monitor workflow";
  if (run.status === WORKFLOW_STATUS.AWAITING_APPROVAL) {
    recommendedAction = "Approver should review the pending approval request";
  } else if (run.status === WORKFLOW_STATUS.APPROVED) {
    recommendedAction = "Operator should execute the approved tool action";
  } else if (run.status === WORKFLOW_STATUS.BLOCKED) {
    recommendedAction = "Admin or operator should review the blocking policy result";
  } else if (run.status === WORKFLOW_STATUS.AWAITING_AGENT) {
    recommendedAction = "Wait for agent completion or inspect agent progress";
  } else if (run.status === WORKFLOW_STATUS.COMPLETED) {
    recommendedAction = "Review audit trail and evidence artifacts";
  }

  return {
    workflowRunId: run.id,
    title: run.title,
    status: run.status,
    currentStep: run.currentStep,
    requester: run.requester,
    request: run.request,
    latestProposal: latestProposal
      ? {
          id: latestProposal.id,
          actionType: latestProposal.actionType,
          status: latestProposal.status,
          confidence: latestProposal.confidence,
          summary: latestProposal.summary,
          riskNotes: latestProposal.riskNotes
        }
      : null,
    latestPolicyCheck: latestPolicyCheck
      ? {
          id: latestPolicyCheck.id,
          result: latestPolicyCheck.result,
          summary: latestPolicyCheck.summary,
          ruleIds: latestPolicyCheck.ruleIds
        }
      : null,
    latestApproval: latestApproval
      ? {
          id: latestApproval.id,
          status: latestApproval.status,
          dueAt: latestApproval.dueAt,
          overdue: isOverdue(latestApproval.dueAt),
          requiredApprovers: latestApproval.requiredApprovers,
          decisions: latestApproval.decisions
        }
      : null,
    openTasks,
    evidenceArtifactCount: run.evidenceArtifacts.length,
    auditEventCount: run.auditEvents.length,
    recommendedAction
  };
}
```


#### Productivity Metrics


```
function listProductivityMetrics({ actor } = {}) {
  assertUserCan(actor, "read_productivity");

  const runs = store.workflowRuns;
  const approvals = store.approvalRequests;
  const proposals = store.toolActionProposals;
  const agentRuns = store.agentRuns;

  const pendingApprovals = approvals.filter((approval) => approval.status === APPROVAL_STATUS.PENDING);
  const approvedProposals = proposals.filter((proposal) => proposal.status === TOOL_ACTION_STATUS.APPROVED);

  const completedRuns = runs.filter((run) => run.status === WORKFLOW_STATUS.COMPLETED);
  const blockedRuns = runs.filter((run) => run.status === WORKFLOW_STATUS.BLOCKED);

  const approvalAges = pendingApprovals.map((approval) => ageMinutes(approval.createdAt));
  const avgPendingApprovalAgeMinutes =
    approvalAges.length === 0
      ? 0
      : Math.round(approvalAges.reduce((sum, value) => sum + value, 0) / approvalAges.length);

  const staleAgentRuns = agentRuns.filter((run) => run.status === "running" && ageMinutes(run.updatedAt) >= 60);

  return {
    totalWorkflowRuns: runs.length,
    completedWorkflowRuns: completedRuns.length,
    blockedWorkflowRuns: blockedRuns.length,
    blockedRate:
      runs.length === 0
        ? 0
        : Number((blockedRuns.length / runs.length).toFixed(2)),

    pendingApprovals: pendingApprovals.length,
    overdueApprovals: pendingApprovals.filter((approval) => isOverdue(approval.dueAt)).length,
    avgPendingApprovalAgeMinutes,

    approvedToolActionsWaitingExecution: approvedProposals.length,
    staleAgentRuns: staleAgentRuns.length,

    byWorkflowStatus: Object.fromEntries(
      Object.values(WORKFLOW_STATUS).map((status) => [
        status,
        runs.filter((run) => run.status === status).length
      ])
    ),

    byToolActionStatus: Object.fromEntries(
      Object.values(TOOL_ACTION_STATUS).map((status) => [
        status,
        proposals.filter((proposal) => proposal.status === status).length
      ])
    )
  };
}
```


#### Collaboration Notes


```
function assertTargetExists(targetType, targetId) {
  if (targetType === "workflow_run") {
    findById(store.workflowRuns, targetId, "WorkflowRun");
    return;
  }
  if (targetType === "approval_request") {
    findById(store.approvalRequests, targetId, "ApprovalRequest");
    return;
  }
  if (targetType === "tool_action_proposal") {
    findById(store.toolActionProposals, targetId, "ToolActionProposal");
    return;
  }
  if (targetType === "agent_run") {
    findById(store.agentRuns, targetId, "AgentRun");
    return;
  }
  throw httpError(400, `Unsupported note target type: ${targetType}`);
}

function createCollaborationNote({ actor, workflowRunId, targetType, targetId, body, visibility = "workspace" }) {
  assertUserCan(actor, "create_note");

  if (!body || !String(body).trim()) {
    throw httpError(400, "Note body is required");
  }

  const workflowRun = findById(store.workflowRuns, workflowRunId, "WorkflowRun");
  assertTargetExists(targetType, targetId);

  const note = {
    id: createId("note"),
    workspaceId: workflowRun.workspaceId,
    workflowRunId,
    targetType,
    targetId,
    authorUserId: actor.id,
    body: String(body).trim(),
    visibility,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  store.collaborationNotes.push(note);

  appendAuditEvent({
    workspaceId: workflowRun.workspaceId,
    workflowRunId,
    actorType: ACTOR_TYPES.USER,
    actorId: actor.id,
    source: "collaboration_service",
    action: "collaboration_note.created",
    targetType: "CollaborationNote",
    targetId: note.id,
    after: note,
    summary: `${actor.name} added a collaboration note`
  });

  return note;
}

function listCollaborationNotes({ actor, workflowRunId }) {
  assertUserCan(actor, "read_productivity");

  return store.collaborationNotes
    .filter((note) => note.workflowRunId === workflowRunId)
    .map((note) => ({
      ...note,
      author: publicUser(store.users.find((user) => user.id === note.authorUserId))
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
```


Return these from `createAppServices`:


```
return {
  // existing service methods...
  listOperatorInbox,
  getRunBrief,
  listProductivityMetrics,
  createCollaborationNote,
  listCollaborationNotes
};
```


### 4. Add HTTP endpoints in `server.js`


Exact routing style is uncertain because `server.js` was not provided. Assuming the existing server maps method/path to service calls, add routes equivalent to:


```
GET /api/productivity/inbox
GET /api/productivity/metrics
GET /api/workflow-runs/:id/brief
GET /api/workflow-runs/:id/notes
POST /api/workflow-runs/:id/notes
```


Example handlers:


```
if (req.method === "GET" && pathname === "/api/productivity/inbox") {
  const actor = services.actorFromUserId?.(query.userId ?? "usr_admin") ?? actorFromRequest(req);
  return sendJson(res, 200, services.listOperatorInbox({ actor }));
}

if (req.method === "GET" && pathname === "/api/productivity/metrics") {
  const actor = services.actorFromUserId?.(query.userId ?? "usr_admin") ?? actorFromRequest(req);
  return sendJson(res, 200, services.listProductivityMetrics({ actor }));
}

const briefMatch = pathname.match(/^\/api\/workflow-runs\/([^/]+)\/brief$/);
if (req.method === "GET" && briefMatch) {
  const actor = services.actorFromUserId?.(query.userId ?? "usr_admin") ?? actorFromRequest(req);
  return sendJson(res, 200, services.getRunBrief({ actor, workflowRunId: briefMatch[1] }));
}

const notesMatch = pathname.match(/^\/api\/workflow-runs\/([^/]+)\/notes$/);
if (req.method === "GET" && notesMatch) {
  const actor = services.actorFromUserId?.(query.userId ?? "usr_admin") ?? actorFromRequest(req);
  return sendJson(res, 200, services.listCollaborationNotes({ actor, workflowRunId: notesMatch[1] }));
}

if (req.method === "POST" && notesMatch) {
  const actor = services.actorFromUserId?.(query.userId ?? "usr_admin") ?? actorFromRequest(req);
  const body = await readJson(req);
  const note = services.createCollaborationNote({
    actor,
    workflowRunId: notesMatch[1],
    targetType: body.targetType,
    targetId: body.targetId,
    body: body.body,
    visibility: body.visibility
  });
  await store.persist?.();
  return sendJson(res, 201, note);
}
```


If `actorFromUserId` is currently private inside `services.js`, either expose a safe wrapper:


```
function getActor(userId = "usr_admin") {
  return publicUser(actorFromUserId(userId));
}
```


or keep actor resolution in `server.js` if that pattern already exists.


### 5. Add UI sections


In the vanilla browser UI, add three panels:


#### Productivity Inbox


```
<section class="panel">
  <div class="panel-header">
    <h2>Productivity Inbox</h2>
    <button id="refreshInboxButton">Refresh</button>
  </div>
  <div id="productivityInbox"></div>
</section>
```


```
async function loadProductivityInbox() {
  const items = await apiGet("/api/productivity/inbox");

  const container = document.querySelector("#productivityInbox");
  container.innerHTML = items.map((item) => `
    <article class="queue-card ${item.overdue ? "queue-card--overdue" : ""}">
      <div class="queue-card__meta">
        <span>${escapeHtml(item.kind.replaceAll("_", " "))}</span>
        <span>Risk: ${escapeHtml(item.risk)}</span>
        <span>Urgency: ${item.urgencyScore}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.summary)}</p>
      <p><strong>Next:</strong> ${escapeHtml(item.nextAction)}</p>
      <button data-open-run="${item.workflowRunId}">Open run</button>
    </article>
  `).join("");
}
```


#### Run Brief Panel


```
<section class="panel">
  <h2>Run Brief</h2>
  <div id="runBrief"></div>
</section>
```


```
async function loadRunBrief(workflowRunId) {
  const brief = await apiGet(`/api/workflow-runs/${workflowRunId}/brief`);
  document.querySelector("#runBrief").innerHTML = `
    <h3>${escapeHtml(brief.title)}</h3>
    <p>Status: ${escapeHtml(brief.status)} · Step: ${escapeHtml(brief.currentStep)}</p>
    <p><strong>Recommended action:</strong> ${escapeHtml(brief.recommendedAction)}</p>
    <dl>
      <dt>Vendor</dt><dd>${escapeHtml(brief.request.vendor)}</dd>
      <dt>Amount</dt><dd>${brief.request.amount} ${escapeHtml(brief.request.currency)}</dd>
      <dt>Department</dt><dd>${escapeHtml(brief.request.department)}</dd>
      <dt>Policy</dt><dd>${escapeHtml(brief.latestPolicyCheck?.summary ?? "No policy check yet")}</dd>
      <dt>Proposal</dt><dd>${escapeHtml(brief.latestProposal?.summary ?? "No proposal yet")}</dd>
    </dl>
  `;
}
```


#### Notes Panel


```
<section class="panel">
  <h2>Collaboration Notes</h2>
  <div id="notesList"></div>
  <textarea id="noteBody" placeholder="Add a note for approvers, operators, or auditors"></textarea>
  <button id="addNoteButton">Add note</button>
</section>
```


```
async function addWorkflowNote(workflowRunId, targetType, targetId) {
  const body = document.querySelector("#noteBody").value;
  await apiPost(`/api/workflow-runs/${workflowRunId}/notes`, {
    targetType,
    targetId,
    body
  });
  document.querySelector("#noteBody").value = "";
  await loadWorkflowNotes(workflowRunId);
}

async function loadWorkflowNotes(workflowRunId) {
  const notes = await apiGet(`/api/workflow-runs/${workflowRunId}/notes`);
  document.querySelector("#notesList").innerHTML = notes.map((note) => `
    <article class="note">
      <strong>${escapeHtml(note.author?.name ?? "Unknown")}</strong>
      <time>${escapeHtml(note.createdAt)}</time>
      <p>${escapeHtml(note.body)}</p>
    </article>
  `).join("");
}
```


Use the app’s existing escaping helper if available. If none exists, add one:


```
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
```


## Why This Is the Best Approach


The current system already has the important primitives: workflow runs, agent runs, proposals, approvals, policy checks, tasks, evidence artifacts, and hash-chained audit events. The missing layer is productivity orchestration.


The highest-value extension is therefore an aggregation and collaboration layer, not a new agent framework or external integration. The Operator Inbox and Run Brief reuse existing state and expose it in a more decision-oriented way. SLA metrics expose operational bottlenecks. Notes close the human-agent-tool collaboration loop while preserving auditability.


This approach is practical because:


* It does not require changing the core workflow lifecycle.
* It does not require adding a new persistence model.
* It works with both in-memory and Postgres-backed state.
* It preserves the existing audit invariant by logging collaboration notes.
* It creates immediate product value in the UI.
* It can be tested with Node’s built-in test runner.



## Risks / Edge Cases


1. **Private helper access**


* `actorFromUserId` appears private inside `createAppServices`.
* Route handlers may already have their own actor resolution.
* If not, expose a controlled service method or keep actor lookup in `server.js`.
2. **Missing `store.js` context**


* The initial store shape was not provided.
* Assumption: adding `collaborationNotes: []` and `savedViews: []` is enough.
* If the store uses stricter initialization or reset logic, update those paths too.
3. **Audit chain growth**


* Every note creates an audit event.
* This is correct for governance, but high note volume may enlarge the JSONB document.
* Later versions may need pagination or separate audit storage.
4. **SLA thresholds**


* The proposal uses `60` minutes for stale agent runs and existing `dueAt` for approvals.
* These should eventually become workspace-level settings.
5. **Authorization nuance**


* `read_productivity` is broad.
* For enterprise use, approvers should probably only see workflows where they are participants unless they are operators, auditors, or admins.
6. **No real-time updates**


* The vanilla UI can poll these endpoints.
* Server-sent events or WebSockets can be added later, but are not necessary for this extension.



## Validation / Tests


Add tests with Node’s built-in test runner.


### 1. Operator Inbox includes pending approvals


```
import test from "node:test";
import assert from "node:assert/strict";
import { createAppServices } from "../src/services.js";
import { createMockStore } from "../src/store.js";

test("operator inbox includes pending approvals for required approver", () => {
  const store = createMockStore();
  const services = createAppServices(store);

  const approver = store.users.find((user) => user.id === "usr_manager");
  const inbox = services.listOperatorInbox({ actor: approver });

  assert.ok(Array.isArray(inbox));
  assert.ok(inbox.every((item) => item.urgencyScore >= 0));
});
```


### 2. Run Brief returns recommended action


```
test("run brief returns deterministic recommended action", () => {
  const store = createMockStore();
  const services = createAppServices(store);

  const actor = store.users.find((user) => user.id === "usr_admin");
  const run = store.workflowRuns[0];

  const brief = services.getRunBrief({
    actor,
    workflowRunId: run.id
  });

  assert.equal(brief.workflowRunId, run.id);
  assert.ok(brief.recommendedAction);
  assert.ok("latestPolicyCheck" in brief);
  assert.ok("openTasks" in brief);
});
```


### 3. Metrics are stable with empty data


```
test("productivity metrics handle empty stores", () => {
  const store = createMockStore();
  store.workflowRuns = [];
  store.approvalRequests = [];
  store.toolActionProposals = [];
  store.agentRuns = [];

  const services = createAppServices(store);
  const actor = store.users.find((user) => user.id === "usr_admin");

  const metrics = services.listProductivityMetrics({ actor });

  assert.equal(metrics.totalWorkflowRuns, 0);
  assert.equal(metrics.blockedRate, 0);
  assert.equal(metrics.pendingApprovals, 0);
});
```


### 4. Collaboration notes are persisted and audited


```
test("creating a collaboration note appends note and audit event", () => {
  const store = createMockStore();
  store.collaborationNotes = [];

  const services = createAppServices(store);
  const actor = store.users.find((user) => user.id === "usr_admin");
  const run = store.workflowRuns[0];

  const beforeAuditCount = store.auditEvents.length;

  const note = services.createCollaborationNote({
    actor,
    workflowRunId: run.id,
    targetType: "workflow_run",
    targetId: run.id,
    body: "Please verify vendor risk before execution."
  });

  assert.ok(note.id.startsWith("note_"));
  assert.equal(store.collaborationNotes.length, 1);
  assert.equal(store.auditEvents.length, beforeAuditCount + 1);
  assert.equal(store.auditEvents.at(-1).action, "collaboration_note.created");
});
```


### 5. Invalid note target fails


```
test("creating a note for invalid target fails", () => {
  const store = createMockStore();
  store.collaborationNotes = [];

  const services = createAppServices(store);
  const actor = store.users.find((user) => user.id === "usr_admin");
  const run = store.workflowRuns[0];

  assert.throws(() => {
    services.createCollaborationNote({
      actor,
      workflowRunId: run.id,
      targetType: "workflow_run",
      targetId: "missing_run",
      body: "Invalid target"
    });
  }, /not found/);
});
```


Manual verification:


```
npm test
npm start
```


Then verify:


```
curl http://localhost:3000/api/productivity/inbox
curl http://localhost:3000/api/productivity/metrics
curl http://localhost:3000/api/workflow-runs/<run_id>/brief
curl http://localhost:3000/api/workflow-runs/<run_id>/notes

curl -X POST http://localhost:3000/api/workflow-runs/<run_id>/notes \
  -H "Content-Type: application/json" \
  -d '{
    "targetType": "workflow_run",
    "targetId": "<run_id>",
    "body": "Approver asked operator to verify vendor risk."
  }'
```


Also verify that the audit timeline includes `collaboration_note.created` and that the audit hash-chain validation still passes if such validation already exists.


## Useful Contributions for Synthesis


* The strongest product direction is a **Productivity Command Center**, not isolated observability widgets.
* Implement first with deterministic aggregation over existing store collections.
* Add:


* `listOperatorInbox`
* `getRunBrief`
* `listProductivityMetrics`
* `createCollaborationNote`
* `listCollaborationNotes`
* Add endpoints:


* `GET /api/productivity/inbox`
* `GET /api/productivity/metrics`
* `GET /api/workflow-runs/:id/brief`
* `GET /api/workflow-runs/:id/notes`
* `POST /api/workflow-runs/:id/notes`
* Add `collaborationNotes: []` to the store.
* Audit every note creation with `appendAuditEvent`.
* Keep the MVP synchronous, JSON-backed, and compatible with the existing Postgres JSONB persistence model.
* Defer WebSockets, LLM summarization, external notifications, and advanced SLA configuration until after the deterministic version is tested.
