import {
  ACTOR_TYPES,
  APPROVAL_STATUS,
  TOOL_ACTION_STATUS,
  WORKFLOW_STATUS,
  assertAgentCan,
  assertUserCan,
  createId,
  httpError,
  nowIso,
  sha256,
  stableJson
} from "./domain.js";

function findById(collection, id, label) {
  const item = collection.find((entry) => entry.id === id);
  if (!item) throw httpError(404, `${label} not found: ${id}`);
  return item;
}

function publicUser(user) {
  if (!user) return null;
  const { id, name, email, department, roles, workspaceId } = user;
  return { id, name, email, department, roles, workspaceId };
}

function publicAgent(agent) {
  if (!agent) return null;
  const { id, workspaceId, name, role, status, allowedWorkflows, allowedActionTypes, scopes } = agent;
  return { id, workspaceId, name, role, status, allowedWorkflows, allowedActionTypes, scopes };
}

function snapshot(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function relativeTime(iso) {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function dueIn(iso) {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "overdue";
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function createAppServices(store) {
  const simulationTimers = new Map();
  const auditSequenceCache = new Map();

  function auditChainKey(workspaceId, workflowRunId) {
    return `${workspaceId}::${workflowRunId ?? "__workspace__"}`;
  }

  function rehydrateAuditSequenceCache() {
    auditSequenceCache.clear();
    for (const event of store.auditEvents) {
      const key = auditChainKey(event.workspaceId, event.workflowRunId);
      const current = auditSequenceCache.get(key);
      if (!current || Number(event.sequence) >= Number(current.sequence)) {
        auditSequenceCache.set(key, {
          workspaceId: event.workspaceId,
          workflowRunId: event.workflowRunId ?? null,
          sequence: Number(event.sequence) || 0,
          hash: event.hash ?? null
        });
      }
    }
  }

  rehydrateAuditSequenceCache();

  function persistInBackground() {
    const result = store.persist?.();
    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        console.error("Failed to persist dashboard state from background task:", error.message);
      });
    }
  }

  function actorFromUserId(userId) {
    if (!userId) {
      throw httpError(401, "Missing x-user-id header");
    }
    const user = store.users.find((entry) => entry.id === userId);
    if (!user) {
      throw httpError(401, `Unknown user identity: ${userId}`);
    }
    return user;
  }

  function agentFromId(agentId, token) {
    const agent = findById(store.agents, agentId, "Agent");
    if (!token) {
      throw httpError(401, "Missing x-agent-token header");
    }
    if (agent.authToken !== token) {
      throw httpError(403, "Invalid agent token");
    }
    return agent;
  }

  function appendAuditEvent({
    workspaceId,
    workflowRunId,
    actorType,
    actorId,
    source = "api",
    action,
    targetType,
    targetId,
    before = null,
    after = null,
    approvalContext = null,
    evidenceArtifactIds = [],
    summary
  }) {
    const chainKey = auditChainKey(workspaceId, workflowRunId);
    const previous = auditSequenceCache.get(chainKey);
    const event = {
      id: createId("aud"),
      workspaceId,
      workflowRunId,
      sequence: previous ? previous.sequence + 1 : 1,
      occurredAt: nowIso(),
      actorType,
      actorId,
      source,
      action,
      targetType,
      targetId,
      before: snapshot(before),
      after: snapshot(after),
      approvalContext: snapshot(approvalContext),
      evidenceArtifactIds: snapshot(evidenceArtifactIds),
      summary,
      previousHash: previous?.hash ?? null
    };
    event.hash = sha256(stableJson({ ...event, hash: undefined }));
    store.auditEvents.push(event);
    auditSequenceCache.set(chainKey, {
      workspaceId,
      workflowRunId: workflowRunId ?? null,
      sequence: event.sequence,
      hash: event.hash
    });
    return event;
  }

  function createEvidenceArtifact({ workspaceId, workflowRunId, kind, title, ownerType = "system", ownerId = "system", payload }) {
    const artifact = {
      id: createId("evi"),
      workspaceId,
      workflowRunId,
      kind,
      title,
      ownerType,
      ownerId,
      payload,
      contentHash: sha256(stableJson(payload)),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    store.evidenceArtifacts.push(artifact);
    appendAuditEvent({
      workspaceId,
      workflowRunId,
      actorType: ACTOR_TYPES.SYSTEM,
      actorId: "system",
      source: "artifact_service",
      action: "artifact.created",
      targetType: "EvidenceArtifact",
      targetId: artifact.id,
      after: artifact,
      summary: `Artifact created: ${title}`
    });
    return artifact;
  }

  function conditionMatches(condition, facts) {
    const actual = facts[condition.field];
    switch (condition.operator) {
      case "gt":
        return Number(actual) > Number(condition.value);
      case "gte":
        return Number(actual) >= Number(condition.value);
      case "lt":
        return Number(actual) < Number(condition.value);
      case "lte":
        return Number(actual) <= Number(condition.value);
      case "eq":
        return actual === condition.value;
      case "neq":
        return actual !== condition.value;
      default:
        throw httpError(400, `Unsupported policy operator: ${condition.operator}`);
    }
  }

  function evaluatePolicy(workflowRun, proposal = null) {
    const facts = {
      ...workflowRun.request,
      ...(proposal?.extractedFields ?? {})
    };
    const matchingRules = store.policyRules.filter(
      (rule) => rule.workspaceId === workflowRun.workspaceId && rule.enabled && conditionMatches(rule.condition, facts)
    );
    const blockingRules = matchingRules.filter((rule) => rule.type === "block");
    const approvalRules = matchingRules.filter((rule) => rule.type === "approval");
    const requiredApprovers = [];

    for (const rule of approvalRules) {
      if (!requiredApprovers.some((approver) => approver.userId === rule.approverUserId)) {
        requiredApprovers.push({
          ruleId: rule.id,
          role: rule.approverRole,
          userId: rule.approverUserId,
          reason: rule.name
        });
      }
    }

    if (requiredApprovers.length === 0 && !blockingRules.length) {
      requiredApprovers.push({
        ruleId: "default_manager_review",
        role: "manager",
        userId: "usr_manager",
        reason: "Default manager review for governed actions"
      });
    }

    return {
      status: blockingRules.length ? "blocked" : "requires_approval",
      result: blockingRules.length ? "blocked" : approvalRules.length ? "alert" : "allowed",
      facts,
      matchingRuleIds: matchingRules.map((rule) => rule.id),
      blockingReasons: blockingRules.map((rule) => rule.reason ?? rule.name),
      requiredApprovers
    };
  }

  function createPolicyCheck({ workflowRun, proposal = null, policyResult, actorType = ACTOR_TYPES.SYSTEM, actorId = "policy_engine", action = "policy.evaluated" }) {
    const check = {
      id: createId("pck"),
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      result: policyResult.result,
      action,
      actorType,
      actorId,
      ruleIds: policyResult.matchingRuleIds,
      proposalId: proposal?.id ?? null,
      summary:
        policyResult.status === "blocked"
          ? policyResult.blockingReasons.join("; ")
          : policyResult.requiredApprovers.length
            ? `Requires ${policyResult.requiredApprovers.length} approval(s)`
            : "Allowed by policy",
      occurredAt: nowIso()
    };
    store.policyChecks.push(check);
    return check;
  }

  function defaultAgentForWorkflow(workflowRun) {
    const definition = store.workflowDefinitions.find((entry) => entry.id === workflowRun.workflowDefinitionId);
    return store.agents.find((agent) => agent.id === definition?.defaultAgentId) ?? store.agents.find((agent) => agent.allowedWorkflows.includes(workflowRun.type));
  }

  function createAgentRun({ workflowRun, agentId, status = "running", progress = 0, waitingOn = null, simulationMode = false }) {
    const agent = agentId ? findById(store.agents, agentId, "Agent") : defaultAgentForWorkflow(workflowRun);
    if (!agent) return null;
    const now = nowIso();
    const existing = store.agentRuns.find((run) => run.workflowRunId === workflowRun.id && run.agentId === agent.id);
    if (existing) return existing;
    const agentRun = {
      id: createId("ar"),
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      status,
      progress,
      waitingOn,
      simulationMode,
      startedAt: now,
      updatedAt: now,
      completedAt: status === "completed" ? now : null
    };
    store.agentRuns.push(agentRun);
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.SYSTEM,
      actorId: "agent_run_service",
      source: "agent_run_service",
      action: "agent_run.started",
      targetType: "AgentRun",
      targetId: agentRun.id,
      after: agentRun,
      summary: `${agent.name} started ${workflowRun.title}`
    });
    return agentRun;
  }

  function updateAgentRunProgress({ agentRunId, progress, status, waitingOn = null }) {
    const agentRun = findById(store.agentRuns, agentRunId, "AgentRun");
    const before = { ...agentRun };
    agentRun.progress = Math.max(0, Math.min(100, Number(progress)));
    agentRun.status = status ?? (agentRun.progress >= 100 ? "completed" : "running");
    agentRun.waitingOn = waitingOn;
    agentRun.updatedAt = nowIso();
    if (agentRun.status === "completed" && !agentRun.completedAt) agentRun.completedAt = nowIso();
    appendAuditEvent({
      workspaceId: agentRun.workspaceId,
      workflowRunId: agentRun.workflowRunId,
      actorType: ACTOR_TYPES.SYSTEM,
      actorId: "agent_run_service",
      source: "agent_run_service",
      action: "agent_run.progressed",
      targetType: "AgentRun",
      targetId: agentRun.id,
      before,
      after: agentRun,
      summary: `${agentRun.agentName} is ${agentRun.progress}% ${agentRun.status}`
    });
    return agentRun;
  }

  function completeAgentRun({ agentRunId, autoSubmitProposal = false }) {
    const agentRun = updateAgentRunProgress({ agentRunId, progress: 100, status: "completed" });
    const workflowRun = findById(store.workflowRuns, agentRun.workflowRunId, "WorkflowRun");
    if (workflowRun.status === WORKFLOW_STATUS.AWAITING_AGENT) {
      workflowRun.status = WORKFLOW_STATUS.AWAITING_APPROVAL;
      workflowRun.updatedAt = nowIso();
    }
    if (autoSubmitProposal && !store.toolActionProposals.some((proposal) => proposal.workflowRunId === workflowRun.id)) {
      const agent = findById(store.agents, agentRun.agentId, "Agent");
      const actionType = agent.allowedActionTypes[0];
      submitAgentProposal({
        agent,
        workflowRunId: workflowRun.id,
        proposal: {
          actionType,
          connectorId: connectorForAction(actionType),
          summary: `${agent.name} completed analysis and proposed ${titleCase(actionType)}.`,
          extractedFields: workflowRun.request,
          confidence: 0.86,
          payload: { simulated: true }
        }
      });
    }
    return getAgentRun(agentRun.id);
  }

  function startAgentRunSimulation({ workflowRunId }) {
    const workflowRun = findById(store.workflowRuns, workflowRunId, "WorkflowRun");
    const agentRun = store.agentRuns.find((run) => run.workflowRunId === workflowRunId) ?? createAgentRun({ workflowRun, progress: 0, simulationMode: true });
    agentRun.simulationMode = true;
    updateAgentRunProgress({ agentRunId: agentRun.id, progress: Math.max(agentRun.progress, 10), status: "running" });
    if (simulationTimers.has(agentRun.id)) return getAgentRun(agentRun.id);
    const steps = [
      { progress: 35, status: "running", waitingOn: null },
      { progress: 70, status: "running", waitingOn: null },
      { progress: 100, status: "completed", waitingOn: null, complete: true }
    ];
    let delay = 700;
    for (const step of steps) {
      const timer = setTimeout(() => {
        if (step.complete) {
          completeAgentRun({ agentRunId: agentRun.id, autoSubmitProposal: true });
          simulationTimers.delete(agentRun.id);
        } else {
          updateAgentRunProgress({ agentRunId: agentRun.id, progress: step.progress, status: step.status, waitingOn: step.waitingOn });
        }
        persistInBackground();
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
      simulationTimers.set(agentRun.id, timer);
      delay += 700;
    }
    return getAgentRun(agentRun.id);
  }

  function connectorForAction(actionType) {
    if (actionType === "create_ticket") return "tool_ticketing";
    if (actionType === "contract_summary") return "tool_contract_db";
    if (actionType === "vendor_contract_approval") return "tool_docusign";
    return "tool_procurement_record";
  }

  function createWorkflowRun({ actor, source = "ui", title, request }) {
    assertUserCan(actor, "create_workflow_run");
    const definition = store.workflowDefinitions.find((entry) => entry.type === "procurement_intake" && entry.status === "active");
    if (!definition) throw httpError(500, "Active procurement workflow definition is missing");
    if (!request?.vendor || !request?.amount || !request?.department) {
      throw httpError(400, "Procurement request requires vendor, amount, and department");
    }
    const now = nowIso();
    const workflowRun = {
      id: createId("run"),
      workspaceId: actor.workspaceId,
      workflowDefinitionId: definition.id,
      type: definition.type,
      title: title || `Procurement request for ${request.vendor}`,
      status: WORKFLOW_STATUS.AWAITING_AGENT,
      source,
      requesterUserId: actor.id,
      request: {
        vendor: request.vendor,
        amount: Number(request.amount),
        currency: request.currency ?? "USD",
        category: request.category ?? "uncategorized",
        department: request.department,
        businessJustification: request.businessJustification ?? "",
        vendorRisk: request.vendorRisk ?? "unknown"
      },
      currentStep: "agent_triage",
      createdAt: now,
      updatedAt: now
    };
    store.workflowRuns.push(workflowRun);
    store.tasks.push({
      id: createId("task"),
      workspaceId: actor.workspaceId,
      workflowRunId: workflowRun.id,
      type: "agent_task",
      status: "open",
      assigneeType: "agent",
      assigneeId: definition.defaultAgentId,
      title: "Classify procurement request and propose next action",
      createdAt: now,
      updatedAt: now
    });
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.USER,
      actorId: actor.id,
      source,
      action: "workflow_run.created",
      targetType: "WorkflowRun",
      targetId: workflowRun.id,
      after: workflowRun,
      summary: `Procurement workflow created for ${workflowRun.request.vendor}`
    });
    createAgentRun({ workflowRun, agentId: definition.defaultAgentId, progress: 0, status: "running" });
    return getWorkflowRun(workflowRun.id);
  }

  function submitAgentProposal({ agent, workflowRunId, proposal }) {
    const workflowRun = findById(store.workflowRuns, workflowRunId, "WorkflowRun");
    assertAgentCan(agent, workflowRun.type, proposal?.actionType);
    if (!proposal?.actionType || !proposal?.summary) {
      throw httpError(400, "Proposal requires actionType and summary");
    }
    const now = nowIso();
    const beforeRun = { ...workflowRun };
    const toolActionProposal = {
      id: createId("tap"),
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      agentId: agent.id,
      actionType: proposal.actionType,
      connectorId: proposal.connectorId ?? connectorForAction(proposal.actionType),
      status: TOOL_ACTION_STATUS.PROPOSED,
      summary: proposal.summary,
      extractedFields: proposal.extractedFields ?? {},
      riskNotes: proposal.riskNotes ?? [],
      confidence: Number(proposal.confidence ?? 0.75),
      payload: proposal.payload ?? {},
      createdAt: now,
      updatedAt: now
    };
    store.toolActionProposals.push(toolActionProposal);
    createEvidenceArtifact({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      kind: "agent_proposal",
      title: `${agent.name} Proposal`,
      ownerType: "agent",
      ownerId: agent.id,
      payload: toolActionProposal
    });
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.AGENT,
      actorId: agent.id,
      source: "agent_api",
      action: "agent.proposal_submitted",
      targetType: "ToolActionProposal",
      targetId: toolActionProposal.id,
      after: toolActionProposal,
      summary: proposal.summary
    });

    const policyResult = evaluatePolicy(workflowRun, toolActionProposal);
    createPolicyCheck({ workflowRun, proposal: toolActionProposal, policyResult });
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.SYSTEM,
      actorId: "policy_engine",
      source: "policy_service",
      action: "policy.evaluated",
      targetType: "WorkflowRun",
      targetId: workflowRun.id,
      after: policyResult,
      summary: policyResult.status === "blocked" ? "Policy blocked proposal" : "Policy evaluated proposal"
    });

    if (policyResult.status === "blocked") {
      toolActionProposal.status = TOOL_ACTION_STATUS.BLOCKED;
      toolActionProposal.updatedAt = nowIso();
      workflowRun.status = WORKFLOW_STATUS.BLOCKED;
      workflowRun.currentStep = "policy_check";
      workflowRun.updatedAt = nowIso();
      appendAuditEvent({
        workspaceId: workflowRun.workspaceId,
        workflowRunId: workflowRun.id,
        actorType: ACTOR_TYPES.SYSTEM,
        actorId: "policy_engine",
        source: "policy_service",
        action: "workflow_run.blocked",
        targetType: "WorkflowRun",
        targetId: workflowRun.id,
        before: beforeRun,
        after: workflowRun,
        summary: policyResult.blockingReasons.join("; ")
      });
      return getWorkflowRun(workflowRun.id);
    }

    toolActionProposal.status = TOOL_ACTION_STATUS.PENDING_APPROVAL;
    toolActionProposal.updatedAt = nowIso();
    workflowRun.status = WORKFLOW_STATUS.AWAITING_APPROVAL;
    workflowRun.currentStep = "approval_gate";
    workflowRun.updatedAt = nowIso();

    const approvalRequest = {
      id: createId("apr"),
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      toolActionProposalId: toolActionProposal.id,
      status: APPROVAL_STATUS.PENDING,
      requiredApprovers: policyResult.requiredApprovers,
      decisions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dueAt: minutesFromNow(180),
      policyResult
    };
    store.approvalRequests.push(approvalRequest);
    store.tasks.push(
      ...policyResult.requiredApprovers.map((approver) => ({
        id: createId("task"),
        workspaceId: workflowRun.workspaceId,
        workflowRunId: workflowRun.id,
        type: "approval",
        status: "open",
        assigneeType: "user",
        assigneeId: approver.userId,
        title: approver.reason,
        approvalRequestId: approvalRequest.id,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }))
    );
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.SYSTEM,
      actorId: "approval_service",
      source: "approval_service",
      action: "approval_request.created",
      targetType: "ApprovalRequest",
      targetId: approvalRequest.id,
      approvalContext: policyResult,
      after: approvalRequest,
      summary: `Created approval request with ${policyResult.requiredApprovers.length} required approver(s)`
    });
    return getWorkflowRun(workflowRun.id);
  }

  function applyApprovalDecision({ actor, approvalRequestId, decision, comment, overrideReason }) {
    assertUserCan(actor, decision === "approved" ? "approve" : "reject");
    const approvalRequest = findById(store.approvalRequests, approvalRequestId, "ApprovalRequest");
    const workflowRun = findById(store.workflowRuns, approvalRequest.workflowRunId, "WorkflowRun");
    const proposal = findById(store.toolActionProposals, approvalRequest.toolActionProposalId, "ToolActionProposal");
    if (approvalRequest.status !== APPROVAL_STATUS.PENDING) {
      throw httpError(409, `Approval request is already ${approvalRequest.status}`);
    }
    const required = approvalRequest.requiredApprovers.find((approver) => approver.userId === actor.id);
    const isAdminOverride = !required && actor.roles.includes("admin") && overrideReason;
    if (!required && !isAdminOverride) {
      throw httpError(403, "User is not a required approver for this request");
    }
    const now = nowIso();
    const decisionRecord = {
      id: createId("dec"),
      actorUserId: actor.id,
      decision,
      comment: comment ?? "",
      overrideReason: overrideReason ?? null,
      decidedAt: now
    };
    approvalRequest.decisions.push(decisionRecord);

    const openTask = store.tasks.find(
      (task) => task.approvalRequestId === approvalRequest.id && task.assigneeId === actor.id && task.status === "open"
    );
    if (openTask) {
      openTask.status = "closed";
      openTask.updatedAt = now;
    }

    if (decision === "rejected") {
      approvalRequest.status = APPROVAL_STATUS.REJECTED;
      proposal.status = TOOL_ACTION_STATUS.REJECTED;
      workflowRun.status = WORKFLOW_STATUS.REJECTED;
      workflowRun.currentStep = "approval_gate";
    } else {
      const approvedUserIds = new Set(approvalRequest.decisions.filter((entry) => entry.decision === "approved").map((entry) => entry.actorUserId));
      const allRequiredApproved = approvalRequest.requiredApprovers.every((approver) => approvedUserIds.has(approver.userId));
      if (allRequiredApproved || isAdminOverride) {
        approvalRequest.status = isAdminOverride ? APPROVAL_STATUS.OVERRIDDEN : APPROVAL_STATUS.APPROVED;
        proposal.status = TOOL_ACTION_STATUS.APPROVED;
        workflowRun.status = WORKFLOW_STATUS.APPROVED;
        workflowRun.currentStep = "tool_action";
      }
    }
    approvalRequest.updatedAt = now;
    proposal.updatedAt = now;
    workflowRun.updatedAt = now;
    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.USER,
      actorId: actor.id,
      source: "approval_service",
      action: `approval_request.${decision}`,
      targetType: "ApprovalRequest",
      targetId: approvalRequest.id,
      after: approvalRequest,
      approvalContext: decisionRecord,
      summary: `${actor.name} ${decision} approval request${overrideReason ? " with override" : ""}`
    });
    return getWorkflowRun(workflowRun.id);
  }

  function executeToolAction({ actor, toolActionProposalId }) {
    assertUserCan(actor, "execute_tool_action");
    const proposal = findById(store.toolActionProposals, toolActionProposalId, "ToolActionProposal");
    if (proposal.status !== TOOL_ACTION_STATUS.APPROVED) {
      throw httpError(409, `Tool action must be approved before execution; current status is ${proposal.status}`);
    }
    const workflowRun = findById(store.workflowRuns, proposal.workflowRunId, "WorkflowRun");
    const connector = findById(store.toolConnectors, proposal.connectorId, "ToolConnector");
    const mergedRequest = { ...workflowRun.request, ...proposal.extractedFields };
    const purchaseRequest = {
      id: createId("pr"),
      externalRef: `PR-${String(store.purchaseRequests.length + 1).padStart(5, "0")}`,
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      vendor: mergedRequest.vendor,
      amount: Number(mergedRequest.amount),
      currency: mergedRequest.currency ?? "USD",
      category: mergedRequest.category,
      department: mergedRequest.department,
      status: "created",
      createdAt: nowIso()
    };
    store.purchaseRequests.push(purchaseRequest);
    const ticket = {
      id: createId("tkt"),
      externalRef: `TICKET-${String(store.tickets.length + 1).padStart(5, "0")}`,
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      subject: workflowRun.title,
      status: "closed",
      linkedPurchaseRequestRef: purchaseRequest.externalRef,
      createdAt: nowIso()
    };
    store.tickets.push(ticket);
    proposal.status = TOOL_ACTION_STATUS.EXECUTED;
    proposal.executionResult = {
      connectorId: connector.id,
      purchaseRequestRef: purchaseRequest.externalRef,
      ticketRef: ticket.externalRef
    };
    proposal.updatedAt = nowIso();
    workflowRun.status = WORKFLOW_STATUS.COMPLETED;
    workflowRun.currentStep = "audit_checkpoint";
    workflowRun.updatedAt = nowIso();

    const artifact = createEvidenceArtifact({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      kind: "tool_execution_result",
      title: `Tool execution result for ${purchaseRequest.externalRef}`,
      ownerType: "tool",
      ownerId: connector.id,
      payload: { purchaseRequest, ticket }
    });

    appendAuditEvent({
      workspaceId: workflowRun.workspaceId,
      workflowRunId: workflowRun.id,
      actorType: ACTOR_TYPES.USER,
      actorId: actor.id,
      source: "connector_service",
      action: "tool_action.executed",
      targetType: "ToolActionProposal",
      targetId: proposal.id,
      after: { proposal, purchaseRequest, ticket },
      evidenceArtifactIds: [artifact.id],
      summary: `Executed ${proposal.actionType} via ${connector.name}`
    });
    return getWorkflowRun(workflowRun.id);
  }

  function getWorkflowRun(id) {
    const run = findById(store.workflowRuns, id, "WorkflowRun");
    return {
      ...run,
      requester: publicUser(store.users.find((user) => user.id === run.requesterUserId)),
      tasks: store.tasks.filter((task) => task.workflowRunId === id),
      agentRuns: store.agentRuns.filter((agentRun) => agentRun.workflowRunId === id).map(getAgentRun),
      approvalRequests: store.approvalRequests.filter((request) => request.workflowRunId === id),
      toolActionProposals: store.toolActionProposals.filter((proposal) => proposal.workflowRunId === id),
      policyChecks: store.policyChecks.filter((check) => check.workflowRunId === id),
      auditEvents: store.auditEvents.filter((event) => event.workflowRunId === id).sort((a, b) => a.sequence - b.sequence),
      evidenceArtifacts: store.evidenceArtifacts.filter((artifact) => artifact.workflowRunId === id)
    };
  }

  function listWorkflowRuns(since) {
    let runs = store.workflowRuns;
    if (since) {
      runs = runs.filter((run) => run.updatedAt >= since || run.createdAt >= since);
    }
    return runs.map((run) => getWorkflowRun(run.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function getAgentRun(idOrRun) {
    const run = typeof idOrRun === "string" ? findById(store.agentRuns, idOrRun, "AgentRun") : idOrRun;
    const agent = store.agents.find((entry) => entry.id === run.agentId);
    return { ...run, agent: publicAgent(agent) };
  }

  function listAgentRuns(filters = {}) {
    let runs = store.agentRuns;
    if (filters.since) {
      runs = runs.filter((run) => run.updatedAt >= filters.since || run.startedAt >= filters.since || run.completedAt >= filters.since);
    }
    return runs
      .filter((run) => !filters.status || run.status === filters.status)
      .map(getAgentRun)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function workItemFromRun(run) {
    const requester = store.users.find((user) => user.id === run.requesterUserId);
    const agentRun = store.agentRuns.find((entry) => entry.workflowRunId === run.id);
    const agent = agentRun ? store.agents.find((entry) => entry.id === agentRun.agentId) : defaultAgentForWorkflow(run);
    return {
      id: `wi_${run.id}`,
      title: run.title,
      owner: requester?.name ?? "Unknown",
      ownerInitials: (requester?.name ?? "??")
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2),
      assignedAgent: agent?.name ?? "Unassigned",
      status: run.status,
      risk: run.request?.vendorRisk ?? run.request?.risk ?? "medium",
      lastUpdated: relativeTime(run.updatedAt),
      workflowRunId: run.id,
      currentStep: run.currentStep,
      workflowType: run.type
    };
  }

  function listWorkItems(filters = {}) {
    let runs = store.workflowRuns;
    if (filters.since) {
      runs = runs.filter((run) => run.updatedAt >= filters.since || run.createdAt >= filters.since);
    }
    return runs
      .map(workItemFromRun)
      .filter((item) => !filters.status || item.status === filters.status)
      .filter((item) => !filters.risk || item.risk === filters.risk)
      .filter((item) => !filters.owner || item.owner === filters.owner)
      .filter((item) => !filters.assignedAgent || item.assignedAgent === filters.assignedAgent)
      .filter((item) => !filters.workflowType || item.workflowType === filters.workflowType);
  }

  function getWorkItem(id) {
    const workflowRunId = id.startsWith("wi_") ? id.slice(3) : id;
    return workItemFromRun(findById(store.workflowRuns, workflowRunId, "WorkflowRun"));
  }

  function listApprovalDashboard() {
    return store.approvalRequests
      .filter((approval) => approval.status === APPROVAL_STATUS.PENDING)
      .map((approval) => {
        const run = findById(store.workflowRuns, approval.workflowRunId, "WorkflowRun");
        const proposal = store.toolActionProposals.find((entry) => entry.id === approval.toolActionProposalId);
        const agent = store.agents.find((entry) => entry.id === proposal?.agentId);
        return {
          id: approval.id,
          title: `Approve ${run.title}`,
          workflowRunId: run.id,
          agentName: agent?.name ?? "Unknown Agent",
          risk: run.request?.vendorRisk ?? "medium",
          status: approval.status,
          dueAt: approval.dueAt,
          dueIn: dueIn(approval.dueAt),
          requiredApprovers: approval.requiredApprovers,
          decisions: approval.decisions
        };
      });
  }

  function listTimeline(since) {
    let events = store.auditEvents;
    if (since) {
      events = events.filter((event) => event.occurredAt >= since);
    }
    return [...events]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 30)
      .map((event) => ({
        id: event.id,
        type: event.action,
        text: event.summary ?? titleCase(event.action),
        actor: `${event.actorType}:${event.actorId}`,
        workflowRunId: event.workflowRunId,
        occurredAt: event.occurredAt,
        ago: relativeTime(event.occurredAt)
      }));
  }

  function listPolicyChecks(since) {
    let checks = store.policyChecks;
    if (since) {
      checks = checks.filter((check) => check.occurredAt >= since);
    }
    return [...checks]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((check) => ({ ...check, ago: relativeTime(check.occurredAt) }));
  }

  function artifactType(artifact) {
    if (artifact.kind !== "report") return titleCase(artifact.kind);
    const title = artifact.title.toLowerCase();
    if (title.includes("weekly") || title.includes("executive") || title.includes("presentation")) return "Presentation";
    if (title.includes("checklist") || title.includes("spreadsheet")) return "Spreadsheet";
    if (title.includes("access review")) return "Workbook";
    if (title.includes("report") || title.includes("assessment") || title.includes("analysis")) return "Report";
    return "Document";
  }

  function artifactSortRank(artifact) {
    if (artifact.kind === "report") return 0;
    if (artifact.kind === "tool_execution_result") return 1;
    if (artifact.kind === "audit_export") return 2;
    if (artifact.kind === "agent_proposal") return 3;
    return 4;
  }

  function artifactWorkflowSortRank(artifact) {
    const run = store.workflowRuns.find((entry) => entry.id === artifact.workflowRunId);
    const order = ["contract_review", "financial_analysis", "security_triage", "market_research", "access_review", "executive_reporting", "procurement_intake"];
    const index = order.indexOf(run?.type);
    return index === -1 ? order.length : index;
  }

  function artifactClassification(artifact, run) {
    const title = artifact.title.toLowerCase();
    const risk = run?.request?.vendorRisk ?? "medium";
    if (title.includes("security") || risk === "sanctioned") {
      return { value: "highly_restricted", label: "Highly Restricted" };
    }
    if (risk === "high" || title.includes("contract") || artifact.kind === "audit_export") {
      return { value: "confidential", label: "Confidential" };
    }
    if (artifact.kind === "tool_execution_result" || artifact.kind === "agent_proposal") {
      return { value: "confidential", label: "Confidential" };
    }
    return { value: "internal", label: "Internal" };
  }

  function artifactAccess(classification, run, artifact) {
    if (classification.value === "highly_restricted") return { value: "restricted", label: "Restricted" };
    if (run?.request?.department === "Executive") return { value: "exec_only", label: "Exec Only" };
    if (classification.value === "confidential") return { value: "restricted", label: "Restricted" };
    if (artifact.title.toLowerCase().includes("marketing")) return { value: "shared", label: "Shared" };
    return { value: "team_access", label: "Team Access" };
  }

  function artifactPolicyStatus({ policyChecks, pendingApproval, classification }) {
    if (policyChecks.some((check) => check.result === "blocked")) return { value: "flagged", label: "Flagged" };
    if (classification.value === "highly_restricted" && !policyChecks.length) return { value: "flagged", label: "Flagged" };
    if (pendingApproval) return { value: "pending_review", label: "Pending Review" };
    if (policyChecks.some((check) => check.result === "alert")) return { value: "needs_approval", label: "Needs Approval" };
    return { value: "compliant", label: "Compliant" };
  }

  function artifactDataSource(run, proposal, artifact) {
    if (artifact.ownerType === "tool") {
      return store.toolConnectors.find((tool) => tool.id === artifact.ownerId)?.name ?? "Tool";
    }
    if (run?.type === "contract_review") return "Contract DB + DocuSign";
    if (run?.type === "financial_analysis") return "Finance Warehouse";
    if (run?.type === "security_triage") return "Security Stack";
    if (run?.type === "access_review") return "IAM Directory";
    if (run?.type === "executive_reporting") return "Reports Warehouse";
    if (proposal?.connectorId) {
      return store.toolConnectors.find((tool) => tool.id === proposal.connectorId)?.name ?? "Tool";
    }
    return "Agent Workspace";
  }

  function artifactAudience(access, run) {
    if (access.value === "restricted" && run?.type === "contract_review") return "Legal Counsel, Contract Owner";
    if (access.value === "restricted") return "Owner, Compliance, Security";
    if (access.value === "exec_only") return "Executive team";
    if (access.value === "shared") return "Marketing team, approved external reviewers";
    return `${run?.request?.department ?? "Workspace"} team`;
  }

  function auditActorName(event) {
    if (event.actorType === ACTOR_TYPES.USER) return store.users.find((user) => user.id === event.actorId)?.name ?? event.actorId;
    if (event.actorType === ACTOR_TYPES.AGENT) return store.agents.find((agent) => agent.id === event.actorId)?.name ?? event.actorId;
    return event.actorId;
  }

  function listArtifacts(since) {
    let artifacts = store.evidenceArtifacts;
    if (since) {
      artifacts = artifacts.filter((art) => art.updatedAt >= since || art.createdAt >= since);
    }
    return [...artifacts]
      .sort((a, b) => artifactSortRank(a) - artifactSortRank(b) || artifactWorkflowSortRank(a) - artifactWorkflowSortRank(b) || b.updatedAt.localeCompare(a.updatedAt))
      .map((artifact) => {
        const run = store.workflowRuns.find((entry) => entry.id === artifact.workflowRunId);
        const requester = store.users.find((user) => user.id === run?.requesterUserId);
        const proposal = store.toolActionProposals.find((entry) => entry.workflowRunId === artifact.workflowRunId);
        const pendingApproval = store.approvalRequests.find((approval) => approval.workflowRunId === artifact.workflowRunId && approval.status === APPROVAL_STATUS.PENDING);
        const policyChecks = store.policyChecks.filter((check) => check.workflowRunId === artifact.workflowRunId);
        const auditEvents = store.auditEvents
          .filter((event) => event.targetId === artifact.id || event.evidenceArtifactIds?.includes(artifact.id) || event.workflowRunId === artifact.workflowRunId)
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
          .slice(0, 8)
          .map((event) => ({
            id: event.id,
            action: event.action,
            summary: event.summary,
            actor: auditActorName(event),
            occurredAt: event.occurredAt,
            ago: relativeTime(event.occurredAt)
          }));
        const owner =
          artifact.ownerType === "agent"
            ? store.agents.find((agent) => agent.id === artifact.ownerId)?.name
            : artifact.ownerType === "tool"
              ? store.toolConnectors.find((tool) => tool.id === artifact.ownerId)?.name
              : "System";
        const classification = artifactClassification(artifact, run);
        const access = artifactAccess(classification, run, artifact);
        const policyStatus = artifactPolicyStatus({ policyChecks, pendingApproval, classification });
        const waitingOn = pendingApproval?.requiredApprovers?.[0]?.userId
          ? store.users.find((user) => user.id === pendingApproval.requiredApprovers[0].userId)?.name
          : null;
        const version = `v${(Number.parseInt(artifact.contentHash.slice(0, 2), 16) % 7) + 1}`;
        const type = artifactType(artifact);
        return {
          id: artifact.id,
          name: artifact.title,
          type,
          typeKey: type.toLowerCase().replaceAll(" ", "_"),
          owner: owner ?? "System",
          ownerType: artifact.ownerType,
          ownerId: artifact.ownerId,
          workflowRunId: artifact.workflowRunId,
          linkedWorkItemTitle: run?.title ?? "Unlinked Artifact",
          linkedWorkItemId: run?.id ?? null,
          department: run?.request?.department ?? requester?.department ?? "Unknown",
          classification: classification.value,
          classificationLabel: classification.label,
          access: access.value,
          accessLabel: access.label,
          policyStatus: policyStatus.value,
          policyStatusLabel: policyStatus.label,
          policyClassification: classification.value === "confidential" && run?.type === "contract_review" ? "Customer-sensitive pricing terms" : classification.label,
          version,
          dataSource: artifactDataSource(run, proposal, artifact),
          createdBy: owner ?? requester?.name ?? "System",
          approvedAudience: artifactAudience(access, run),
          sharingPolicy: access.value === "restricted" ? "External sharing requires approval" : access.value === "shared" ? "External sharing allowed for approved audience" : "Internal sharing allowed",
          retentionPolicy: run?.type === "contract_review" ? "7 years" : "365 days",
          needsReview: policyStatus.value !== "compliant",
          slaStatus: pendingApproval && pendingApproval.dueAt && !Number.isNaN(new Date(pendingApproval.dueAt).getTime()) && new Date(pendingApproval.dueAt).getTime() < Date.now() ? "breached" : "healthy",
          waitingOn,
          summary: artifact.kind === "agent_proposal" ? proposal?.summary : `Generated artifact for ${run?.title ?? "workflow"}.`,
          policyChecks: policyChecks.map((check) => ({ ...check, ago: relativeTime(check.occurredAt) })),
          auditEvents,
          contentHash: artifact.contentHash,
          createdAt: artifact.createdAt,
          created: relativeTime(artifact.createdAt),
          updatedAt: artifact.updatedAt,
          updated: relativeTime(artifact.updatedAt)
        };
      });
  }

  function policyAuditSummary() {
    const checks = store.policyChecks;
    const count = (result) => checks.filter((check) => check.result === result).length;
    return {
      allChecks: checks.length,
      allowed: count("allowed"),
      blocked: count("blocked"),
      alerts: count("alert")
    };
  }

  function maxIso(...values) {
    const valid = values.filter(Boolean).map((value) => new Date(value).getTime()).filter((value) => !Number.isNaN(value));
    if (!valid.length) return null;
    return new Date(Math.max(...valid)).toISOString();
  }

  function readModelCursor() {
    const timestamps = [
      ...store.workflowRuns.flatMap((run) => [run.createdAt, run.updatedAt]),
      ...store.tasks.flatMap((task) => [task.createdAt, task.updatedAt]),
      ...store.approvalRequests.flatMap((approval) => [approval.createdAt, approval.updatedAt, ...(approval.decisions ?? []).map((decision) => decision.decidedAt)]),
      ...store.toolActionProposals.flatMap((proposal) => [proposal.createdAt, proposal.updatedAt]),
      ...store.agentRuns.flatMap((run) => [run.startedAt, run.updatedAt, run.completedAt]),
      ...store.policyChecks.map((check) => check.occurredAt),
      ...store.auditEvents.map((event) => event.occurredAt),
      ...store.evidenceArtifacts.flatMap((artifact) => [artifact.createdAt, artifact.updatedAt]),
      ...store.purchaseRequests.map((request) => request.createdAt),
      ...store.tickets.map((ticket) => ticket.createdAt)
    ];
    return maxIso(...timestamps) ?? nowIso();
  }

  function hasChangedSince(item, since, fields) {
    if (!since) return true;
    return fields.some((field) => {
      const value = item[field];
      return value && value >= since;
    });
  }

  function listAuditEvents(since) {
    let events = store.auditEvents;
    if (since) {
      events = events.filter((event) => event.occurredAt >= since);
    }
    return [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  function listApprovalRequests(since) {
    let approvals = store.approvalRequests;
    if (since) {
      approvals = approvals.filter((approval) => {
        if (hasChangedSince(approval, since, ["createdAt", "updatedAt"])) return true;
        return (approval.decisions ?? []).some((decision) => decision.decidedAt >= since);
      });
    }
    return [...approvals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function listToolActionProposals(since) {
    let proposals = store.toolActionProposals;
    if (since) {
      proposals = proposals.filter((proposal) => hasChangedSince(proposal, since, ["createdAt", "updatedAt"]));
    }
    return [...proposals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function pct(value, total) {
    if (!total) return null;
    return Math.round((value / total) * 100);
  }

  function analytics() {
    const buckets = [
      { key: "under_1k", label: "< $1k", tone: "green", count: 0, totalSpend: 0 },
      { key: "between_1k_10k", label: "$1k - $10k", tone: "blue", count: 0, totalSpend: 0 },
      { key: "over_10k", label: "> $10k", tone: "amber", count: 0, totalSpend: 0 },
      { key: "blocked", label: "Blocked", tone: "red", count: 0, totalSpend: 0 }
    ];

    for (const run of store.workflowRuns) {
      const amount = Number(run.request?.amount ?? 0);
      const bucket =
        run.status === WORKFLOW_STATUS.BLOCKED || run.request?.vendorRisk === "sanctioned"
          ? buckets[3]
          : amount < 1000
            ? buckets[0]
            : amount <= 10000
              ? buckets[1]
              : buckets[2];
      bucket.count += 1;
      bucket.totalSpend += amount;
    }

    const maxSpend = Math.max(0, ...buckets.map((bucket) => bucket.totalSpend));
    for (const bucket of buckets) {
      bucket.heightPercent = maxSpend ? Math.max(8, Math.round((bucket.totalSpend / maxSpend) * 100)) : 0;
    }

    const proposals = store.toolActionProposals.filter((proposal) => Number.isFinite(Number(proposal.confidence)));
    const averageConfidence = proposals.length
      ? Math.round((proposals.reduce((sum, proposal) => sum + Number(proposal.confidence), 0) / proposals.length) * 100)
      : null;

    const now = Date.now();
    const decidedApprovals = store.approvalRequests.filter((approval) => approval.status !== APPROVAL_STATUS.PENDING && approval.decisions?.length);
    const pendingBreaches = store.approvalRequests.filter((approval) => approval.status === APPROVAL_STATUS.PENDING && approval.dueAt && new Date(approval.dueAt).getTime() < now);
    const onTimeDecisions = decidedApprovals.filter((approval) => {
      const finalDecisionAt = approval.decisions.reduce((latest, decision) => {
        const decidedAt = new Date(decision.decidedAt).getTime();
        return Number.isNaN(decidedAt) ? latest : Math.max(latest, decidedAt);
      }, 0);
      return finalDecisionAt && approval.dueAt && finalDecisionAt <= new Date(approval.dueAt).getTime();
    });
    const slaPopulation = decidedApprovals.length + pendingBreaches.length;
    const slaComplianceRate = slaPopulation ? pct(onTimeDecisions.length, slaPopulation) : null;

    const resolvedProposals = store.toolActionProposals.filter((proposal) => [TOOL_ACTION_STATUS.APPROVED, TOOL_ACTION_STATUS.EXECUTED].includes(proposal.status));
    const nonBlockedProposals = store.toolActionProposals.filter((proposal) => proposal.status !== TOOL_ACTION_STATUS.BLOCKED);
    const automaticRouteAccuracy = nonBlockedProposals.length ? pct(resolvedProposals.length, nonBlockedProposals.length) : null;

    return {
      spendBuckets: buckets,
      efficiency: [
        { key: "triage_confidence", label: "Triage Agent Confidence", value: averageConfidence, tone: "green" },
        { key: "sla_compliance", label: "SLA Compliance Rate", value: slaComplianceRate, tone: "blue" },
        { key: "route_accuracy", label: "Automatic Route Accuracy", value: automaticRouteAccuracy, tone: "purple" }
      ],
      counts: {
        workflowRuns: store.workflowRuns.length,
        proposals: store.toolActionProposals.length,
        approvals: store.approvalRequests.length,
        pendingSlaBreaches: pendingBreaches.length
      }
    };
  }

  function dashboardMetrics() {
    return [
      { label: "Active Work Items", value: store.workflowRuns.filter((run) => run.status !== WORKFLOW_STATUS.COMPLETED).length, delta: "Live", tone: "blue", icon: "▣" },
      { label: "Running Agents", value: store.agentRuns.filter((run) => run.status === "running").length, delta: "Live", tone: "green", icon: "🤖" },
      { label: "Pending Approvals", value: store.approvalRequests.filter((approval) => approval.status === APPROVAL_STATUS.PENDING).length, delta: "Live", tone: "amber", icon: "⏳" },
      { label: "Completed Tasks", value: store.workflowRuns.filter((run) => run.status === WORKFLOW_STATUS.COMPLETED).length, delta: "Live", tone: "purple", icon: "✓" },
      { label: "Policy Alerts", value: store.policyChecks.filter((check) => check.result !== "allowed").length, delta: "Live", tone: "red", icon: "⬡" }
    ];
  }

  function dashboard() {
    return {
      metrics: dashboardMetrics(),
      workItems: listWorkItems(),
      agentRuns: listAgentRuns(),
      humanApprovals: listApprovalDashboard(),
      timeline: listTimeline(),
      analytics: analytics(),
      policyAudit: {
        summary: policyAuditSummary(),
        checks: listPolicyChecks().slice(0, 10)
      },
      artifacts: listArtifacts(),
      delegationMap: getDelegationMapForLatestRun()
    };
  }

  function getDelegationMapForLatestRun() {
    const run = [...store.workflowRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!run) return { nodes: [], edges: [] };
    return getDelegationMap(run.id);
  }

  function getDelegationMap(workflowRunId) {
    const run = findById(store.workflowRuns, workflowRunId, "WorkflowRun");
    const requester = store.users.find((user) => user.id === run.requesterUserId);
    const agentRun = store.agentRuns.find((entry) => entry.workflowRunId === run.id);
    const agent = agentRun ? store.agents.find((entry) => entry.id === agentRun.agentId) : defaultAgentForWorkflow(run);
    const proposal = store.toolActionProposals.find((entry) => entry.workflowRunId === run.id);
    const connector = proposal ? store.toolConnectors.find((entry) => entry.id === proposal.connectorId) : store.toolConnectors.find((entry) => entry.id === "tool_policy_engine");
    const nodes = [
      { id: "human", type: "human", label: requester?.name ?? "Unknown Owner", subtitle: "Owner" },
      { id: "agent", type: "agent", label: agent?.name ?? "Unassigned Agent", subtitle: agent?.role ?? "Agent" },
      { id: "work", type: "work", label: run.title, subtitle: titleCase(run.status) },
      { id: "tool", type: "tool", label: connector?.name ?? "Tool", subtitle: connector?.type ?? "Tool" },
      { id: "policy", type: "service", label: "Policy Engine", subtitle: "Service" }
    ];
    const edges = [
      { from: "human", to: "work", type: "owns" },
      { from: "work", to: "agent", type: "delegated_to" },
      { from: "agent", to: "tool", type: "uses" },
      { from: "tool", to: "policy", type: "governed_by" }
    ];
    return { workflowRunId: run.id, nodes, edges };
  }

  function auditTrail({ actor, workflowRunId }) {
    assertUserCan(actor, "read_audit");
    return getWorkflowRun(workflowRunId).auditEvents;
  }

  function auditExport({ actor, workflowRunId }) {
    assertUserCan(actor, "read_audit");
    const run = getWorkflowRun(workflowRunId);
    const artifact = createEvidenceArtifact({
      workspaceId: run.workspaceId,
      workflowRunId: run.id,
      kind: "audit_export",
      title: `Audit export for ${run.title}`,
      payload: { workflowRunId: run.id, generatedBy: actor.id, generatedAt: nowIso() }
    });
    return {
      generatedAt: nowIso(),
      generatedBy: publicUser(actor),
      workflowRun: run,
      exportArtifactId: artifact.id,
      hashChainValid: validateAuditHashChain(workflowRunId)
    };
  }

  function verifyAuditChainEvents({ workspaceId, workflowRunId, events }) {
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.occurredAt.localeCompare(b.occurredAt));
    const failures = [];
    let previousHash = null;
    let expectedSequence = 1;

    for (const event of ordered) {
      const expectedHash = sha256(stableJson({ ...event, hash: undefined }));
      if (event.sequence !== expectedSequence) {
        failures.push({
          eventId: event.id,
          sequence: event.sequence,
          expectedSequence,
          reason: "sequence_gap_or_duplicate"
        });
      }
      if (event.previousHash !== previousHash) {
        failures.push({
          eventId: event.id,
          sequence: event.sequence,
          reason: "previous_hash_mismatch",
          expectedPreviousHash: previousHash,
          actualPreviousHash: event.previousHash
        });
      }
      if (event.hash !== expectedHash) {
        failures.push({
          eventId: event.id,
          sequence: event.sequence,
          reason: "event_hash_mismatch",
          expectedHash,
          actualHash: event.hash
        });
      }
      previousHash = event.hash;
      expectedSequence += 1;
    }

    return {
      workspaceId,
      workflowRunId: workflowRunId ?? null,
      valid: failures.length === 0,
      eventCount: ordered.length,
      lastSequence: ordered.at(-1)?.sequence ?? 0,
      lastHash: ordered.at(-1)?.hash ?? null,
      failures
    };
  }

  function validateAuditHashChain(workflowRunId) {
    const events = store.auditEvents.filter((event) => event.workflowRunId === workflowRunId);
    const first = events[0];
    if (!first) return true;
    return verifyAuditChainEvents({ workspaceId: first.workspaceId, workflowRunId, events }).valid;
  }

  function validateAllAuditHashChains() {
    const grouped = new Map();
    for (const event of store.auditEvents) {
      const key = auditChainKey(event.workspaceId, event.workflowRunId);
      if (!grouped.has(key)) {
        grouped.set(key, {
          workspaceId: event.workspaceId,
          workflowRunId: event.workflowRunId ?? null,
          events: []
        });
      }
      grouped.get(key).events.push(event);
    }

    const chains = [...grouped.values()]
      .map((group) => verifyAuditChainEvents(group))
      .sort((a, b) => String(a.workflowRunId ?? "").localeCompare(String(b.workflowRunId ?? "")));
    const failedChains = chains.filter((chain) => !chain.valid);
    return {
      checkedAt: nowIso(),
      valid: failedChains.length === 0,
      chainCount: chains.length,
      eventCount: store.auditEvents.length,
      failedChainCount: failedChains.length,
      chains
    };
  }

  function healthCheck() {
    const audit = validateAllAuditHashChains();
    const arrayCollections = [
      "workspaces",
      "users",
      "agents",
      "workflowRuns",
      "tasks",
      "approvalRequests",
      "toolActionProposals",
      "agentRuns",
      "policyChecks",
      "auditEvents",
      "evidenceArtifacts"
    ];
    const missingCollections = arrayCollections.filter((key) => !Array.isArray(store[key]));
    const healthy = missingCollections.length === 0 && audit.valid;
    return {
      status: healthy ? "healthy" : "degraded",
      checkedAt: nowIso(),
      storage: {
        type: store.storage?.type ?? "memory",
        ok: missingCollections.length === 0,
        missingCollections
      },
      audit: {
        status: audit.valid ? "healthy" : "degraded",
        valid: audit.valid,
        chainCount: audit.chainCount,
        eventCount: audit.eventCount,
        failedChainCount: audit.failedChainCount
      },
      simulator: {
        status: "healthy",
        activeTimers: simulationTimers.size
      }
    };
  }

  function observabilitySnapshot() {
    return {
      ...bootstrap(),
      cursor: readModelCursor(),
      health: healthCheck()
    };
  }

  function observabilityChanges(since) {
    if (!since) {
      throw httpError(400, "changes endpoint requires a since cursor");
    }
    const policyChecks = listPolicyChecks(since);
    return {
      cursor: readModelCursor(),
      changes: {
        workflowRuns: listWorkflowRuns(since),
        agentRuns: listAgentRuns({ since }),
        workItems: listWorkItems({ since }),
        approvalRequests: listApprovalRequests(since),
        humanApprovals: listApprovalDashboard(),
        toolActionProposals: listToolActionProposals(since),
        policyChecks,
        timeline: listTimeline(since),
        auditEvents: listAuditEvents(since),
        artifacts: listArtifacts(since)
      },
      dashboard: {
        metrics: dashboardMetrics(),
        analytics: analytics(),
        policyAudit: {
          summary: policyAuditSummary(),
          checks: policyChecks.length ? listPolicyChecks().slice(0, 10) : undefined
        }
      },
      health: healthCheck()
    };
  }

  function updatePolicyRule({ actor, ruleId, patch }) {
    assertUserCan(actor, "update_policy");
    const rule = findById(store.policyRules, ruleId, "PolicyRule");
    const before = { ...rule };
    Object.assign(rule, {
      name: patch.name ?? rule.name,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : rule.enabled,
      condition: patch.condition ?? rule.condition,
      approverUserId: patch.approverUserId ?? rule.approverUserId,
      approverRole: patch.approverRole ?? rule.approverRole,
      reason: patch.reason ?? rule.reason
    });
    appendAuditEvent({
      workspaceId: rule.workspaceId,
      workflowRunId: null,
      actorType: ACTOR_TYPES.USER,
      actorId: actor.id,
      source: "admin_api",
      action: "policy_rule.updated",
      targetType: "PolicyRule",
      targetId: rule.id,
      before,
      after: rule,
      summary: `Policy rule updated: ${rule.name}`
    });
    return rule;
  }

  function receiveWebhookEvent({ source, eventType, payload }) {
    const actor = actorFromUserId(payload?.requesterUserId ?? "usr_requester");
    if (eventType === "procurement_intake") {
      return createWorkflowRun({
        actor,
        source,
        title: payload.title,
        request: payload.request
      });
    }
    const workspaceId = actor.workspaceId;
    const artifact = {
      id: createId("wh"),
      workspaceId,
      source,
      eventType,
      payload,
      receivedAt: nowIso()
    };
    appendAuditEvent({
      workspaceId,
      workflowRunId: null,
      actorType: ACTOR_TYPES.WEBHOOK,
      actorId: source,
      source,
      action: "webhook.received",
      targetType: "WebhookEvent",
      targetId: artifact.id,
      after: artifact,
      summary: `Webhook received from ${source}: ${eventType}`
    });
    return artifact;
  }

  function bootstrap() {
    return {
      workspace: store.workspaces[0],
      users: store.users.map(publicUser),
      agents: store.agents.map(publicAgent),
      toolConnectors: store.toolConnectors,
      workflowDefinitions: store.workflowDefinitions,
      policyRules: store.policyRules,
      dashboard: dashboard(),
      workflowRuns: listWorkflowRuns(),
      approvalRequests: store.approvalRequests,
      toolActionProposals: store.toolActionProposals,
      purchaseRequests: store.purchaseRequests,
      tickets: store.tickets
    };
  }

  return {
    store,
    actorFromUserId,
    agentFromId,
    appendAuditEvent,
    createWorkflowRun,
    submitAgentProposal,
    applyApprovalDecision,
    executeToolAction,
    createAgentRun,
    getAgentRun,
    listAgentRuns,
    updateAgentRunProgress,
    completeAgentRun,
    startAgentRunSimulation,
    getWorkflowRun,
    listWorkflowRuns,
    listWorkItems,
    getWorkItem,
    listApprovalDashboard,
    listTimeline,
    listPolicyChecks,
    listArtifacts,
    getDelegationMap,
    dashboard,
    auditTrail,
    auditExport,
    validateAuditHashChain,
    validateAllAuditHashChains,
    healthCheck,
    observabilitySnapshot,
    observabilityChanges,
    evaluatePolicy,
    updatePolicyRule,
    receiveWebhookEvent,
    bootstrap,
    dashboardMetrics,
    analytics,
    readModelCursor
  };
}
