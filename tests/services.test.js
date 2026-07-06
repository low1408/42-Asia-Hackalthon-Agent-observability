import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore } from "../src/store.js";
import { createAppServices } from "../src/services.js";

function createHarness() {
  const store = createSeedStore();
  const services = createAppServices(store);
  return {
    store,
    services,
    requester: services.actorFromUserId("usr_requester"),
    manager: services.actorFromUserId("usr_manager"),
    finance: services.actorFromUserId("usr_finance"),
    compliance: services.actorFromUserId("usr_compliance"),
    operator: services.actorFromUserId("usr_operator"),
    admin: services.actorFromUserId("usr_admin"),
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

test("procurement request creates workflow and append-only audit event", () => {
  const { services, requester } = createHarness();
  const run = createRun(services, requester, { amount: 900, vendorRisk: "low" });

  assert.equal(run.status, "awaiting_agent");
  assert.equal(run.tasks[0].type, "agent_task");
  assert.equal(run.agentRuns.length, 1);
  assert.equal(run.auditEvents.length, 2);
  assert.equal(run.auditEvents[0].action, "workflow_run.created");
  assert.equal(run.auditEvents[1].action, "agent_run.started");
  assert.equal(services.validateAuditHashChain(run.id), true);
});

test("agent proposal creates approval request based on amount and vendor risk policy", () => {
  const { services, requester, agent } = createHarness();
  const run = createRun(services, requester);
  const updated = submitProposal(services, agent, run);

  assert.equal(updated.status, "awaiting_approval");
  assert.equal(updated.toolActionProposals[0].status, "pending_approval");
  assert.deepEqual(
    updated.approvalRequests[0].requiredApprovers.map((approver) => approver.userId).sort(),
    ["usr_compliance", "usr_finance", "usr_manager"]
  );
  assert.equal(services.validateAuditHashChain(run.id), true);
});

test("all required approvals are needed before tool action can execute", () => {
  const { services, requester, agent, manager, finance, compliance, operator } = createHarness();
  let run = createRun(services, requester);
  run = submitProposal(services, agent, run);
  const approvalId = run.approvalRequests[0].id;
  const proposalId = run.toolActionProposals[0].id;

  run = services.applyApprovalDecision({ actor: manager, approvalRequestId: approvalId, decision: "approved", comment: "manager ok" });
  assert.equal(run.status, "awaiting_approval");
  assert.throws(
    () => services.executeToolAction({ actor: operator, toolActionProposalId: proposalId }),
    /must be approved/
  );

  run = services.applyApprovalDecision({ actor: finance, approvalRequestId: approvalId, decision: "approved", comment: "finance ok" });
  run = services.applyApprovalDecision({ actor: compliance, approvalRequestId: approvalId, decision: "approved", comment: "compliance ok" });
  assert.equal(run.status, "approved");

  run = services.executeToolAction({ actor: operator, toolActionProposalId: proposalId });
  assert.equal(run.status, "completed");
  assert.equal(run.toolActionProposals[0].status, "executed");
  assert.match(run.toolActionProposals[0].executionResult.purchaseRequestRef, /^PR-/);
  assert.equal(services.validateAuditHashChain(run.id), true);
});

test("sanctioned vendor policy blocks external tool proposal", () => {
  const { services, requester, agent } = createHarness();
  const run = createRun(services, requester, { amount: 2000, vendorRisk: "sanctioned" });
  const updated = submitProposal(services, agent, run);

  assert.equal(updated.status, "blocked");
  assert.equal(updated.toolActionProposals[0].status, "blocked");
  assert.equal(updated.approvalRequests.length, 0);
});

test("rbac prevents requester from executing a governed tool action", () => {
  const { services, requester, agent, manager } = createHarness();
  let run = createRun(services, requester, { amount: 900, vendorRisk: "low" });
  run = submitProposal(services, agent, run);
  const approvalId = run.approvalRequests[0].id;
  const proposalId = run.toolActionProposals[0].id;
  run = services.applyApprovalDecision({ actor: manager, approvalRequestId: approvalId, decision: "approved", comment: "ok" });

  assert.equal(run.status, "approved");
  assert.throws(
    () => services.executeToolAction({ actor: requester, toolActionProposalId: proposalId }),
    /not allowed/
  );
});

test("admin can reject approval request with explicit override reason", () => {
  const { services, requester, agent, admin } = createHarness();
  let run = createRun(services, requester, { amount: 900, vendorRisk: "low" });
  run = submitProposal(services, agent, run);

  run = services.applyApprovalDecision({
    actor: admin,
    approvalRequestId: run.approvalRequests[0].id,
    decision: "rejected",
    comment: "Not approved from dashboard.",
    overrideReason: "Admin override from dashboard"
  });

  assert.equal(run.status, "rejected");
  assert.equal(run.approvalRequests[0].status, "rejected");
  assert.equal(run.toolActionProposals[0].status, "rejected");
  assert.equal(run.approvalRequests[0].decisions[0].overrideReason, "Admin override from dashboard");
});

test("admin can update policy rules and webhook can create intake request", () => {
  const { services, admin } = createHarness();
  const rule = services.updatePolicyRule({
    actor: admin,
    ruleId: "pol_amount_finance",
    patch: { enabled: false }
  });
  assert.equal(rule.enabled, false);

  const run = services.receiveWebhookEvent({
    source: "slack",
    eventType: "procurement_intake",
    payload: {
      requesterUserId: "usr_requester",
      title: "Slack-sourced procurement request",
      request: {
        vendor: "DeskCo",
        amount: 1500,
        department: "Operations",
        category: "furniture",
        vendorRisk: "low"
      }
    }
  });
  assert.equal(run.source, "slack");
  assert.equal(run.status, "awaiting_agent");
});

test("dashboard read model is computed from real domain records", () => {
  const { services, requester, agent } = createHarness();
  const before = services.dashboard();
  const run = createRun(services, requester, { vendor: "ReadModelCo", amount: 3000, vendorRisk: "medium" });
  const afterCreate = services.dashboard();

  assert.equal(afterCreate.workItems.some((item) => item.workflowRunId === run.id), true);
  assert.equal(afterCreate.metrics.find((metric) => metric.label === "Active Work Items").value, before.metrics.find((metric) => metric.label === "Active Work Items").value + 1);

  const afterProposal = submitProposal(services, agent, run);
  const dashboard = services.dashboard();
  assert.equal(dashboard.humanApprovals.some((approval) => approval.workflowRunId === afterProposal.id), true);
  assert.equal(dashboard.policyAudit.checks.some((check) => check.workflowRunId === afterProposal.id), true);
  assert.equal(dashboard.artifacts.some((artifact) => artifact.workflowRunId === afterProposal.id), true);
});

test("artifact read model includes linked workflow and governance metadata", () => {
  const { services } = createHarness();
  const artifacts = services.listArtifacts();
  const contract = artifacts.find((artifact) => artifact.name === "Contract Summary Draft");

  assert.ok(contract);
  assert.equal(contract.linkedWorkItemTitle, "Vendor Contract Review");
  assert.equal(contract.department, "Legal");
  assert.equal(contract.classification, "confidential");
  assert.equal(contract.access, "restricted");
  assert.equal(contract.policyStatus, "pending_review");
  assert.equal(contract.dataSource, "Contract DB + DocuSign");
  assert.equal(contract.approvedAudience, "Legal Counsel, Contract Owner");
  assert.match(contract.version, /^v[1-7]$/);
  assert.equal(Array.isArray(contract.policyChecks), true);
  assert.equal(Array.isArray(contract.auditEvents), true);
  assert.equal(contract.auditEvents.some((event) => event.action === "artifact.created"), true);
});

test("agent run lifecycle updates dashboard and timeline", () => {
  const { services, requester } = createHarness();
  const run = createRun(services, requester, { vendor: "AgentRunCo", amount: 900, vendorRisk: "low" });
  const agentRun = run.agentRuns[0];

  services.updateAgentRunProgress({ agentRunId: agentRun.id, progress: 55, status: "running" });
  let dashboard = services.dashboard();
  assert.equal(dashboard.agentRuns.find((entry) => entry.id === agentRun.id).progress, 55);

  services.completeAgentRun({ agentRunId: agentRun.id, autoSubmitProposal: true });
  dashboard = services.dashboard();
  assert.equal(dashboard.agentRuns.find((entry) => entry.id === agentRun.id).status, "completed");
  assert.equal(dashboard.timeline.some((event) => event.type === "agent_run.progressed"), true);
  assert.equal(dashboard.humanApprovals.some((approval) => approval.workflowRunId === run.id), true);
});

test("delegation map and artifact rows are generated from workflow relationships", () => {
  const { services, requester, agent, manager, operator } = createHarness();
  let run = createRun(services, requester, { amount: 900, vendorRisk: "low" });
  run = submitProposal(services, agent, run);
  run = services.applyApprovalDecision({ actor: manager, approvalRequestId: run.approvalRequests[0].id, decision: "approved", comment: "ok" });
  run = services.executeToolAction({ actor: operator, toolActionProposalId: run.toolActionProposals[0].id });

  const map = services.getDelegationMap(run.id);
  assert.deepEqual(
    map.nodes.map((node) => node.type).sort(),
    ["agent", "human", "service", "tool", "work"]
  );
  assert.equal(services.listArtifacts().some((artifact) => artifact.workflowRunId === run.id && artifact.type === "Tool Execution Result"), true);
});
