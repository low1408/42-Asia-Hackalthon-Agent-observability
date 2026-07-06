import crypto from "node:crypto";

export const ROLES = Object.freeze({
  REQUESTER: "requester",
  APPROVER: "approver",
  OPERATOR: "operator",
  AUDITOR: "auditor",
  ADMIN: "admin",
  AGENT: "agent"
});

export const WORKFLOW_STATUS = Object.freeze({
  INTAKE: "intake",
  AWAITING_AGENT: "awaiting_agent",
  AWAITING_APPROVAL: "awaiting_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  BLOCKED: "blocked",
  EXECUTED: "executed",
  COMPLETED: "completed"
});

export const APPROVAL_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  OVERRIDDEN: "overridden"
});

export const TOOL_ACTION_STATUS = Object.freeze({
  PROPOSED: "proposed",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXECUTED: "executed",
  BLOCKED: "blocked"
});

export const ACTOR_TYPES = Object.freeze({
  USER: "user",
  AGENT: "agent",
  SYSTEM: "system",
  TOOL: "tool",
  WEBHOOK: "webhook"
});

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hasAnyRole(actor, allowedRoles) {
  if (!actor || !Array.isArray(actor.roles)) return false;
  return actor.roles.some((role) => allowedRoles.includes(role));
}

export function assertUserCan(actor, action) {
  const grants = {
    create_workflow_run: [ROLES.REQUESTER, ROLES.OPERATOR, ROLES.ADMIN],
    approve: [ROLES.APPROVER, ROLES.ADMIN],
    reject: [ROLES.APPROVER, ROLES.ADMIN],
    execute_tool_action: [ROLES.OPERATOR, ROLES.ADMIN],
    read_audit: [ROLES.AUDITOR, ROLES.ADMIN, ROLES.OPERATOR],
    update_policy: [ROLES.ADMIN],
    read_admin: [ROLES.ADMIN],
    override_approval: [ROLES.ADMIN]
  };
  if (!hasAnyRole(actor, grants[action] ?? [])) {
    const identity = actor ? `${actor.name} (${actor.id})` : "anonymous";
    const error = new Error(`${identity} is not allowed to ${action}`);
    error.status = 403;
    throw error;
  }
}

export function assertAgentCan(agent, workflowType, actionType) {
  if (!agent || agent.status !== "active") {
    const error = new Error("Agent is inactive or unknown");
    error.status = 403;
    throw error;
  }
  if (!agent.allowedWorkflows.includes(workflowType)) {
    const error = new Error(`Agent ${agent.name} cannot access workflow type ${workflowType}`);
    error.status = 403;
    throw error;
  }
  if (actionType && !agent.allowedActionTypes.includes(actionType)) {
    const error = new Error(`Agent ${agent.name} cannot propose action type ${actionType}`);
    error.status = 403;
    throw error;
  }
}

export function httpError(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}
