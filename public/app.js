const state = {
  bootstrap: null,
  actorId: "usr_admin",
  pollTimer: null,
  currentRoute: routeFromHash(),
  selectedWorkflowRunId: null,
  selectedTab: "overview",
  selectedArtifactId: null,
  selectedArtifactTab: "overview",
  loadingAction: null,
  flashMessage: "",
  errorMessage: "",
  pollErrorCount: 0,
  lastLoadedAt: null,
  cursor: null,
  health: null,
  auditVerification: null,
  auditEvents: [],
  auditFilters: {
    search: "",
    actor: "all",
    actionType: "all",
    targetType: "all",
    risk: "all",
    date: "any",
    sortKey: "timestamp",
    sortDirection: "desc"
  },
  filters: {
    search: "",
    status: "all",
    agent: "all",
    risk: "all",
    owner: "all",
    department: "all",
    duration: "any",
    humanAction: "all",
    sla: "all",
    sortKey: "lastUpdated",
    sortDirection: "desc"
  },
  artifactFilters: {
    search: "",
    type: "all",
    classification: "all",
    owner: "all",
    access: "all",
    policyStatus: "all",
    department: "all",
    date: "any",
    needsReview: "all",
    sla: "all",
    sortKey: "updated",
    sortDirection: "desc"
  }
};

const el = {
  app: document.querySelector("#app"),
  actorSelect: document.querySelector("#actorSelect"),
  avatar: document.querySelector(".avatar"),
  systemStatus: document.querySelector("#systemStatus")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-user-id": state.actorId,
      ...(options.headers || {})
    }
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  
  if (response.status !== 204) {
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch (err) {
        throw new Error("Failed to parse JSON response from server");
      }
    } else {
      try {
        const text = await response.text();
        throw new Error(text || `Server returned status ${response.status}`);
      } catch (err) {
        throw new Error(err.message || `Server returned status ${response.status}`);
      }
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return payload;
}

function updateSystemStatus() {
  if (!el.systemStatus) return;
  if (state.pollErrorCount > 0) {
    el.systemStatus.className = "system-status offline";
    el.systemStatus.innerHTML = '<span class="status-indicator-dot red-dot" style="display:inline-block;width:9px;height:9px;border-radius:999px;background:#f04438;margin-right:8px;"></span> Connection offline (' + state.pollErrorCount + ' failures)';
  } else if (state.health && state.health.status !== "healthy") {
    el.systemStatus.className = "system-status degraded";
    const auditStatus = state.health.audit?.valid === false ? "audit chain degraded" : "backend degraded";
    el.systemStatus.innerHTML = '<span class="status-indicator-dot amber-dot" style="display:inline-block;width:9px;height:9px;border-radius:999px;background:#f79009;margin-right:8px;"></span> Degraded: ' + escapeHtml(auditStatus);
  } else {
    el.systemStatus.className = "system-status online";
    const timeStr = state.lastLoadedAt ? ' (Updated ' + formatClock(state.lastLoadedAt) + ')' : '';
    el.systemStatus.innerHTML = '<span class="status-indicator-dot green-dot" style="display:inline-block;width:9px;height:9px;border-radius:999px;background:#12b76a;margin-right:8px;"></span> All systems operational' + timeStr;
  }
}

function renderInitialLoadError(error) {
  if (!el.app) return;
  el.app.className = "dashboard empty-state-container";
  el.app.innerHTML = `
    <div class="panel initial-load-error-card" style="max-width: 600px; margin: 40px auto; padding: 32px; text-align: center; border: 1px solid var(--red); box-shadow: var(--shadow); border-radius: 14px; background: #fff;">
      <div class="error-badge" style="display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 999px; background: var(--red-soft); color: var(--red); font-size: 24px; font-weight: 800; margin-bottom: 20px;">⚠</div>
      <h2 style="margin: 0 0 12px; font-size: 20px; color: var(--text);">Connection Failure</h2>
      <p style="margin: 0 0 24px; color: var(--muted); font-size: 14px; line-height: 1.5;">Could not boot the dashboard because the Agent Enterprise API services are unreachable or returned an error.</p>
      <div class="error-stack-wrapper" style="text-align: left; background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 24px; max-height: 200px; overflow-y: auto;">
        <strong style="display: block; font-size: 12px; color: #475467; margin-bottom: 6px;">Error details:</strong>
        <pre style="margin: 0; font-family: monospace; font-size: 12px; color: var(--red); white-space: pre-wrap; word-break: break-all;">${escapeHtml(error.stack || error.message || error)}</pre>
      </div>
      <button id="retryBootstrapBtn" class="primary-button" style="display: inline-flex; align-items: center; gap: 8px; font-weight: 700; padding: 10px 16px; border-radius: 10px; background: var(--blue); color: #fff; border: none; cursor: pointer;">⟳ Retry Connection</button>
    </div>
  `;
  document.getElementById("retryBootstrapBtn")?.addEventListener("click", () => {
    location.reload();
  });
}

async function ensureAuditEventsLoaded(force = false) {
  if (!canReadAudit()) {
    state.auditEvents = [];
    state.auditVerification = null;
    state.errorMessage = "Current user is not authorized to read audit events.";
    return;
  }
  if (!force && state.auditEvents.length) return;
  const res = await api("/api/audit-events");
  state.auditEvents = res.auditEvents || [];
  state.errorMessage = "";
}

async function load() {
  try {
    const snapshot = await api("/api/observability/snapshot");
    if (!snapshot) throw new Error("Dashboard snapshot response was empty");
    state.bootstrap = snapshot;
    state.pollErrorCount = 0;
    state.cursor = state.bootstrap.cursor || new Date().toISOString();
    state.health = state.bootstrap.health || null;
    state.lastLoadedAt = state.cursor;
    updateSystemStatus();
    
    if (state.currentRoute === "audit") {
      await ensureAuditEventsLoaded(true);
    }
    
    ensureSelectedRun();
    ensureSelectedArtifact();
    render();
    configurePolling();
  } catch (error) {
    console.error("Dashboard boot failure:", error);
    state.pollErrorCount = (state.pollErrorCount || 0) + 1;
    updateSystemStatus();
    if (!state.bootstrap) {
      renderInitialLoadError(error);
    } else {
      state.errorMessage = "Failed to load update: " + error.message;
      render();
    }
  }
}

function routeFromHash() {
  return (location.hash || "#").replace("#", "") || "home";
}

function pageForRoute(route) {
  if (route === "agentRuns") return "agentRuns";
  if (route === "artifacts") return "artifacts";
  if (route === "audit") return "audit";
  if (route === "workboard") return "workboard";
  if (route === "policyAudit") return "policyAudit";
  if (route === "settings") return "settings";
  if (route === "integrations") return "integrations";
  if (route === "people") return "people";
  if (route === "analytics") return "analytics";
  return "home";
}

function dashboard() {
  return state.bootstrap.dashboard;
}

function users() {
  return state.bootstrap.users || [];
}

function currentActor() {
  return users().find((user) => user.id === state.actorId);
}

function actorHasRole(role) {
  return Boolean(currentActor()?.roles?.includes(role));
}

function canReadAudit() {
  return ["auditor", "operator", "admin"].some(actorHasRole);
}

function canExecuteTools() {
  return ["operator", "admin"].some(actorHasRole);
}

function canUpdatePolicy() {
  return actorHasRole("admin");
}

function canDecideApproval(approval) {
  const actor = currentActor();
  if (!actor || approval?.status !== "pending") return false;
  const requiredUserIds = approval.requiredApprovers?.map((approver) => approver.userId) || [];
  return requiredUserIds.includes(actor.id) || actor.roles.includes("admin");
}

function renderFeedback() {
  if (!state.flashMessage && !state.errorMessage) return "";
  return (
    '<section class="feedback-stack" aria-live="polite">' +
    (state.flashMessage ? '<div class="feedback success">✓ ' + escapeHtml(state.flashMessage) + "</div>" : "") +
    (state.errorMessage ? '<div class="feedback error">⚠ ' + escapeHtml(state.errorMessage) + "</div>" : "") +
    "</section>"
  );
}

function actionAttrs(action, key, extra = "") {
  const busy = state.loadingAction === key;
  return ' data-action="' + escapeHtml(action) + '" data-action-key="' + escapeHtml(key) + '"' + (busy ? ' disabled aria-busy="true"' : "") + (extra ? " " + extra : "");
}

function comingSoonButton(label, className = "") {
  return '<button class="' + escapeHtml(className) + '" disabled aria-disabled="true" title="Coming soon in a future backend-backed workflow">' + escapeHtml(label) + "</button>";
}

async function runUiAction(key, successMessage, callback) {
  if (state.loadingAction) return;
  state.loadingAction = key;
  state.flashMessage = "";
  state.errorMessage = "";
  render();
  try {
    const result = await callback();
    state.flashMessage = successMessage;
    return result;
  } catch (error) {
    state.errorMessage = error.message || "Action failed";
  } finally {
    state.loadingAction = null;
    render();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleCase(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

function initials(name) {
  return String(name || "??")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function statusBadge(status) {
  return '<span class="badge status-' + escapeHtml(status || "unknown") + '">' + escapeHtml(titleCase(status || "Unknown")) + "</span>";
}

function riskBadge(risk) {
  return '<span class="badge risk-' + escapeHtml(risk || "medium") + '">' + escapeHtml(titleCase(risk || "Medium")) + "</span>";
}

function smallBadge(value, tone) {
  return '<span class="badge ' + escapeHtml(tone || "") + '">' + escapeHtml(value) + "</span>";
}

function relativeTime(iso) {
  if (!iso) return "—";
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function dueIn(iso) {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "overdue";
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? hours + "h " + remainder + "m" : remainder + "m";
}

function durationFrom(startIso, endIso) {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const minutes = Math.max(1, Math.round((end - new Date(startIso).getTime()) / 60000));
  if (minutes < 60) return minutes + "m";
  return Math.round(minutes / 60) + "h";
}

function formatClock(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function findUser(id) {
  return users().find((user) => user.id === id);
}

function runAgentRun(run) {
  return run.agentRuns?.[0] || dashboard().agentRuns.find((entry) => entry.workflowRunId === run.id) || null;
}

function pendingApprovals(run) {
  return (run.approvalRequests || []).filter((approval) => approval.status === "pending");
}

function runRisk(run) {
  return run.request?.vendorRisk || run.request?.risk || "medium";
}

function latestEvent(run) {
  const events = [...(run.auditEvents || [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return events[0] || null;
}

let enrichedRunsCache = null;
let lastWorkflowRunsRef = null;

function enrichedRuns() {
  const runs = state.bootstrap?.workflowRuns || [];
  if (enrichedRunsCache && lastWorkflowRunsRef === runs) {
    return enrichedRunsCache;
  }
  
  enrichedRunsCache = runs.map((run) => {
    const agentRun = runAgentRun(run);
    const owner = run.requester || findUser(run.requesterUserId);
    const approvals = pendingApprovals(run);
    const event = latestEvent(run);
    return {
      run,
      agentRun,
      owner,
      approvals,
      latestEvent: event,
      risk: runRisk(run),
      status: agentRun?.status || run.status,
      progress: Number(agentRun?.progress ?? 0),
      waitingOn: approvals[0]?.requiredApprovers?.[0]?.userId ? findUser(approvals[0].requiredApprovers[0].userId)?.name : agentRun?.waitingOn,
      duration: durationFrom(agentRun?.startedAt || run.createdAt, agentRun?.completedAt),
      durationMinutes: durationMinutes({ run, agentRun }),
      lastUpdatedAt: event?.occurredAt || agentRun?.completedAt || agentRun?.startedAt || run.updatedAt || run.createdAt,
      department: run.request?.department || owner?.department || "Unknown"
    };
  });
  
  lastWorkflowRunsRef = runs;
  return enrichedRunsCache;
}

function filteredRuns() {
  const filters = state.filters;
  const rows = enrichedRuns().filter((item) => {
    const search = filters.search.trim().toLowerCase();
    if (search) {
      const haystack = [
        item.run.title,
        item.agentRun?.role,
        item.run.type,
        item.agentRun?.agentName,
        item.owner?.name,
        item.status,
        item.run.status,
        item.risk,
        item.waitingOn,
        item.department,
        item.latestEvent?.action,
        item.latestEvent?.summary
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (state.filters.status !== "all" && item.status !== state.filters.status && item.run.status !== state.filters.status) return false;
    if (state.filters.agent !== "all" && item.agentRun?.agentId !== state.filters.agent) return false;
    if (state.filters.risk !== "all" && item.risk !== state.filters.risk) return false;
    if (state.filters.owner !== "all" && item.owner?.id !== state.filters.owner) return false;
    if (state.filters.department !== "all" && item.department !== state.filters.department) return false;
    if (state.filters.humanAction === "yes" && item.approvals.length === 0) return false;
    if (state.filters.humanAction === "no" && item.approvals.length > 0) return false;
    if (state.filters.sla === "breached" && !item.approvals.some((approval) => approval.dueAt && !Number.isNaN(new Date(approval.dueAt).getTime()) && new Date(approval.dueAt).getTime() < Date.now())) return false;
    if (state.filters.sla === "healthy" && item.approvals.some((approval) => approval.dueAt && !Number.isNaN(new Date(approval.dueAt).getTime()) && new Date(approval.dueAt).getTime() < Date.now())) return false;
    if (state.filters.duration === "under10" && durationMinutes(item) >= 10) return false;
    if (state.filters.duration === "over10" && durationMinutes(item) <= 10) return false;
    return true;
  });
  return sortRuns(rows);
}

function sortRuns(rows) {
  const direction = state.filters.sortDirection === "asc" ? 1 : -1;
  const valueFor = (item) => {
    if (state.filters.sortKey === "duration") return item.durationMinutes;
    if (state.filters.sortKey === "status") return item.status;
    if (state.filters.sortKey === "risk") return item.risk;
    if (state.filters.sortKey === "progress") return item.progress;
    return new Date(item.lastUpdatedAt || 0).getTime();
  };
  return [...rows].sort((a, b) => {
    const av = valueFor(a);
    const bv = valueFor(b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });
}

function durationMinutes(item) {
  const started = item.agentRun?.startedAt || item.run.createdAt;
  const ended = item.agentRun?.completedAt || new Date().toISOString();
  return Math.max(1, Math.round((new Date(ended).getTime() - new Date(started).getTime()) / 60000));
}

function ensureSelectedRun() {
  const runs = enrichedRuns();
  if (!runs.length) return;
  const stillExists = runs.some((item) => item.run.id === state.selectedWorkflowRunId);
  if (stillExists) return;
  const needsHuman = runs.find((item) => item.approvals.length > 0);
  state.selectedWorkflowRunId = (needsHuman || runs[0]).run.id;
}

function selectedRunItem() {
  if (!state.selectedWorkflowRunId) return null;
  return enrichedRuns().find((item) => item.run.id === state.selectedWorkflowRunId) || null;
}

function enrichedArtifacts() {
  return (dashboard().artifacts || []).map((artifact) => ({
    ...artifact,
    typeKey: artifact.typeKey || slug(artifact.type),
    classification: artifact.classification || "internal",
    classificationLabel: artifact.classificationLabel || titleCase(artifact.classification || "internal"),
    access: artifact.access || "team_access",
    accessLabel: artifact.accessLabel || titleCase(artifact.access || "team_access"),
    policyStatus: artifact.policyStatus || "compliant",
    policyStatusLabel: artifact.policyStatusLabel || titleCase(artifact.policyStatus || "compliant"),
    department: artifact.department || "Unknown",
    slaStatus: artifact.slaStatus || "healthy",
    needsReview: Boolean(artifact.needsReview)
  }));
}

function filteredArtifacts() {
  const filters = state.artifactFilters;
  const rows = enrichedArtifacts().filter((artifact) => {
    const search = filters.search.trim().toLowerCase();
    if (search) {
      const haystack = [artifact.name, artifact.type, artifact.owner, artifact.linkedWorkItemTitle, artifact.department, artifact.classificationLabel, artifact.accessLabel, artifact.policyStatusLabel].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (filters.type !== "all" && artifact.typeKey !== filters.type) return false;
    if (filters.classification !== "all" && artifact.classification !== filters.classification) return false;
    if (filters.owner !== "all" && artifact.owner !== filters.owner) return false;
    if (filters.access !== "all" && artifact.access !== filters.access) return false;
    if (filters.policyStatus !== "all" && artifact.policyStatus !== filters.policyStatus) return false;
    if (filters.department !== "all" && artifact.department !== filters.department) return false;
    if (filters.needsReview === "yes" && !artifact.needsReview) return false;
    if (filters.needsReview === "no" && artifact.needsReview) return false;
    if (filters.sla === "breached" && artifact.slaStatus !== "breached") return false;
    if (filters.sla === "healthy" && artifact.slaStatus === "breached") return false;
    if (filters.date !== "any") {
      const ageHours = Math.max(0, (Date.now() - new Date(artifact.updatedAt || artifact.createdAt).getTime()) / 3600000);
      if (filters.date === "today" && ageHours > 24) return false;
      if (filters.date === "week" && ageHours > 24 * 7) return false;
      if (filters.date === "month" && ageHours > 24 * 30) return false;
    }
    return true;
  });
  return sortArtifacts(rows);
}

function sortArtifacts(rows) {
  const direction = state.artifactFilters.sortDirection === "asc" ? 1 : -1;
  const valueFor = (artifact) => {
    if (state.artifactFilters.sortKey === "name") return artifact.name;
    if (state.artifactFilters.sortKey === "policyStatus") return artifact.policyStatusLabel || artifact.policyStatus;
    if (state.artifactFilters.sortKey === "classification") return artifact.classificationLabel || artifact.classification;
    if (state.artifactFilters.sortKey === "owner") return artifact.owner;
    return new Date(artifact.updatedAt || artifact.createdAt || 0).getTime();
  };
  return [...rows].sort((a, b) => {
    const av = valueFor(a);
    const bv = valueFor(b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });
}

function ensureSelectedArtifact(candidates = enrichedArtifacts()) {
  if (!candidates.length) {
    state.selectedArtifactId = null;
    return;
  }
  const stillExists = candidates.some((artifact) => artifact.id === state.selectedArtifactId);
  if (stillExists) return;
  const needsReview = candidates.find((artifact) => artifact.needsReview);
  state.selectedArtifactId = (needsReview || candidates[0]).id;
}

function selectedArtifact() {
  if (!state.selectedArtifactId) return null;
  return enrichedArtifacts().find((artifact) => artifact.id === state.selectedArtifactId) || null;
}

function render() {
  renderActorPicker();
  renderNavigation();
  const page = pageForRoute(state.currentRoute);
  if (page === "agentRuns") {
    renderAgentRunsPage();
  } else if (page === "artifacts") {
    renderArtifactsPage();
  } else if (page === "audit") {
    renderAuditPage();
  } else if (page === "workboard") {
    renderWorkboardPage();
  } else if (page === "policyAudit") {
    renderPolicyAuditPage();
  } else if (page === "settings" || page === "integrations" || page === "people") {
    renderSettingsPage();
  } else if (page === "analytics") {
    renderAnalyticsPage();
  } else {
    renderHomePage();
  }
}

function renderActorPicker() {
  el.actorSelect.innerHTML = users()
    .map((user) => {
      const selected = user.id === state.actorId ? " selected" : "";
      return '<option value="' + escapeHtml(user.id) + '"' + selected + ">" + escapeHtml(user.name.split(" ")[0]) + "</option>";
    })
    .join("");
  const actor = currentActor();
  if (actor) el.avatar.textContent = initials(actor.name);
}

function renderNavigation() {
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === state.currentRoute || (state.currentRoute === "home" && link.dataset.route === "home"));
  });
}

function findActorName(event) {
  if (event.actorType === "user") {
    const u = users().find(user => user.id === event.actorId);
    return u ? u.name : event.actorId;
  }
  if (event.actorType === "agent") {
    const a = state.bootstrap.agents.find(agent => agent.id === event.actorId);
    return a ? a.name : event.actorId;
  }
  return event.actorId;
}

function resetAuditFilters() {
  state.auditFilters = {
    search: "",
    actor: "all",
    actionType: "all",
    targetType: "all",
    risk: "all",
    date: "any",
    sortKey: "timestamp",
    sortDirection: "desc"
  };
}

function filteredAudits() {
  const filters = state.auditFilters;
  const events = state.auditEvents || [];
  
  return events.filter(event => {
    const search = filters.search.trim().toLowerCase();
    if (search) {
      const actorName = findActorName(event).toLowerCase();
      const haystack = [
        event.id,
        event.action,
        event.summary,
        event.actorId,
        actorName,
        event.targetType,
        event.targetId
      ].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    
    if (filters.actor !== "all") {
      if (event.actorId !== filters.actor && event.actorType !== filters.actor) return false;
    }
    
    if (filters.actionType !== "all" && event.action !== filters.actionType) return false;
    if (filters.targetType !== "all" && event.targetType !== filters.targetType) return false;
    
    if (filters.date !== "any") {
      const ageHours = Math.max(0, (Date.now() - new Date(event.occurredAt).getTime()) / 3600000);
      if (filters.date === "today" && ageHours > 24) return false;
      if (filters.date === "week" && ageHours > 24 * 7) return false;
      if (filters.date === "month" && ageHours > 24 * 30) return false;
    }
    
    if (filters.risk !== "all") {
      const runId = event.workflowRunId || (event.targetType === "WorkflowRun" ? event.targetId : null);
      if (runId) {
        const run = state.bootstrap.workflowRuns.find(r => r.id === runId);
        const risk = run?.request?.vendorRisk || run?.request?.risk || "medium";
        if (risk !== filters.risk) return false;
      } else {
        return false;
      }
    }
    
    return true;
  });
}

function renderAuditDetailsDrawer() {
  if (!state.selectedAuditEventId) return "";
  const event = state.auditEvents.find(e => e.id === state.selectedAuditEventId);
  if (!event) return "";

  return `
    <aside class="artifact-detail-drawer panel" style="position: fixed; inset: 0 0 0 auto; width: 480px; z-index: 10; border-left: 1px solid var(--line); background: #fff; box-shadow: -10px 0 30px rgba(0,0,0,0.05); padding: 24px; display: flex; flex-direction: column; overflow-y: auto;">
      <div class="drawer-heading" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 20px;">
        <div>
          <span class="badge status-running">Audit Trace Event</span>
          <h2 style="margin: 8px 0 0; font-size: 18px;">${escapeHtml(event.action)}</h2>
        </div>
        <button data-action="close-audit-drawer" style="border:none; background:none; font-size:24px; cursor:pointer;">×</button>
      </div>

      <dl class="run-facts" style="display: grid; gap: 12px; font-size: 13px; margin-bottom: 20px;">
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Event ID</dt><dd><code>${escapeHtml(event.id)}</code></dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Sequence ID</dt><dd><code>#${event.sequence ?? '—'}</code></dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Occurred At</dt><dd>${escapeHtml(event.occurredAt)}</dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Actor Type</dt><dd>${escapeHtml(titleCase(event.actorType))}</dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Actor ID</dt><dd><code>${escapeHtml(event.actorId)}</code></dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Resource Type</dt><dd>${escapeHtml(event.targetType)}</dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Resource ID</dt><dd><code>${escapeHtml(event.targetId)}</code></dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Workflow Run ID</dt><dd><code>${escapeHtml(event.workflowRunId || 'N/A')}</code></dd></div>
        <div style="display:flex; justify-content:space-between;"><dt style="color:var(--muted); font-weight:700;">Source</dt><dd><code>${escapeHtml(event.source)}</code></dd></div>
      </dl>

      <div style="border-top: 1px solid var(--line); padding-top: 16px; margin-top: 16px;">
        <h4 style="margin: 0 0 10px;">Audit Cryptographic Hash</h4>
        <div style="font-family: monospace; font-size: 11px; background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid var(--line); word-break: break-all;">
          <strong>Block Hash:</strong><br>${escapeHtml(event.hash || '—')}<br><br>
          <strong>Prev Hash:</strong><br>${escapeHtml(event.previousHash || '—')}
        </div>
      </div>

      <div style="border-top: 1px solid var(--line); padding-top: 16px; margin-top: 16px; flex: 1;">
        <h4 style="margin: 0 0 10px;">Payload State Snapshot</h4>
        <pre style="margin: 0; font-family: monospace; font-size: 11px; background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid var(--line); overflow: auto; max-height: 250px; white-space: pre-wrap;">${escapeHtml(JSON.stringify(event.after || event.before || {}, null, 2))}</pre>
      </div>
    </aside>
  `;
}

function renderAuditPage() {
  const rows = filteredAudits();
  const verification = state.auditVerification;
  const verificationBanner = verification
    ? '<section class="feedback-stack"><div class="feedback ' + (verification.valid ? 'success' : 'error') + '">' + (verification.valid ? '✓ ' : '⚠ ') + escapeHtml(verification.valid ? 'All audit hash chains verified.' : verification.failedChainCount + ' audit hash chain(s) failed verification.') + ' <small>Checked ' + escapeHtml(formatClock(verification.checkedAt)) + ' · ' + escapeHtml(verification.eventCount) + ' events</small></div></section>'
    : '';
  el.app.className = "dashboard audit-page";

  const allEvents = state.auditEvents || [];
  const actors = allEvents.map(e => ({ value: e.actorId, label: findActorName(e) }));
  const actions = allEvents.map(e => ({ value: e.action, label: titleCase(e.action) }));
  const targets = allEvents.map(e => ({ value: e.targetType, label: titleCase(e.targetType) }));

  el.app.innerHTML = `
    <section class="page-header">
      <div>
        <h1>Audit Log & Trace Investigation</h1>
        <p>Inspect immutable system execution logs, cryptographic hash chains, and user/agent compliance trails.</p>
      </div>
      <div class="page-actions">
        <button class="primary-button" data-action="verify-hash-chains">✓ Verify Cryptographic Chain</button>
      </div>
    </section>
    ${renderFeedback()}
    ${verificationBanner}
    <section class="run-filters">
      <input class="run-search-input" data-audit-search type="search" placeholder="Search actor, resource ID, or summary..." value="${escapeHtml(state.auditFilters.search)}" />
      <label>Actor
        <select data-audit-filter="actor">
          ${selectOptions(actors, state.auditFilters.actor, "All")}
        </select>
      </label>
      <label>Action Type
        <select data-audit-filter="actionType">
          ${selectOptions(actions, state.auditFilters.actionType, "All")}
        </select>
      </label>
      <label>Resource Type
        <select data-audit-filter="targetType">
          ${selectOptions(targets, state.auditFilters.targetType, "All")}
        </select>
      </label>
      <label>Risk
        <select data-audit-filter="risk">
          <option value="all">All</option>
          <option value="low" ${state.auditFilters.risk === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${state.auditFilters.risk === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${state.auditFilters.risk === 'high' ? 'selected' : ''}>High</option>
          <option value="sanctioned" ${state.auditFilters.risk === 'sanctioned' ? 'selected' : ''}>Sanctioned</option>
        </select>
      </label>
      <label>Date
        <select data-audit-filter="date">
          <option value="any">Any</option>
          <option value="today" ${state.auditFilters.date === 'today' ? 'selected' : ''}>Last 24h</option>
          <option value="week" ${state.auditFilters.date === 'week' ? 'selected' : ''}>Last 7d</option>
          <option value="month" ${state.auditFilters.date === 'month' ? 'selected' : ''}>Last 30d</option>
        </select>
      </label>
      <button data-action="clear-audit-filters">Clear</button>
    </section>

    <div class="panel span-12">
      <div class="table-card">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Sequence</th>
              <th>Actor</th>
              <th>Action Type</th>
              <th>Resource</th>
              <th>Integrity</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `
              <tr>
                <td colspan="7" style="text-align: center; padding: 40px; color: var(--muted);">No audit events match the active filters.</td>
              </tr>
            ` : rows.map(event => `
                <tr style="cursor: pointer;" data-audit-event-id="${escapeHtml(event.id)}">
                  <td style="font-size:12px;">${escapeHtml(formatClock(event.occurredAt))} <small class="muted" style="display:block;">${escapeHtml(relativeTime(event.occurredAt))}</small></td>
                  <td><code>#${event.sequence ?? '—'}</code></td>
                  <td><span class="owner-chip">${escapeHtml(initials(findActorName(event)))}</span>${escapeHtml(findActorName(event))}</td>
                  <td><span class="badge status-in_progress" style="font-size:11px;">${escapeHtml(event.action)}</span></td>
                  <td><code style="font-size:11px;">${escapeHtml(event.targetType)}:${escapeHtml(event.targetId)}</code></td>
                  <td>
                    <span class="badge status-completed" style="font-size:11px; display:inline-flex; align-items:center; gap:4px;">
                      🛡️ Valid
                    </span>
                  </td>
                  <td><strong>${escapeHtml(event.summary || event.text)}</strong></td>
                </tr>
              `).join("")}
          </tbody>
        </table>
      </div>
    </div>
    ${renderAuditDetailsDrawer()}
  `;
}

function renderWorkboardPage() {
  const rows = dashboard().workItems;
  el.app.className = "dashboard workboard-page";
  el.app.innerHTML = `
    <section class="page-header">
      <div>
        <h1>Work Items</h1>
        <p>View all active, completed, and blocked human-agent collaborative procurement work items.</p>
      </div>
      <div>
        <button class="primary-button" data-action="create-run">＋ Create Request</button>
      </div>
    </section>
    ${renderFeedback()}
    <div class="panel span-12">
      <div class="panel-heading"><h2>All Work Items <span class="count-badge">${rows.length}</span></h2></div>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Owner</th>
              <th>Assigned Agent</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr style="cursor: pointer;" data-workflow-run-id="${escapeHtml(row.workflowRunId)}">
                <td><span class="doc-icon">▧</span>${escapeHtml(row.title)}</td>
                <td><span class="owner-chip">${escapeHtml(row.ownerInitials)}</span>${escapeHtml(row.owner)}</td>
                <td>🤖 ${escapeHtml(row.assignedAgent)}</td>
                <td>${statusBadge(row.status)}</td>
                <td>${riskBadge(row.risk)}</td>
                <td>${escapeHtml(row.lastUpdated)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="table-footer">Showing ${rows.length} of ${rows.length} items</div>
      </div>
    </div>
    ${renderRunDrawer()}
  `;
}

function renderPolicyAuditPage() {
  el.app.className = "dashboard policy-page";
  el.app.innerHTML = `
    <section class="page-header">
      <div>
        <h1>Policy & Governance Rules</h1>
        <p>Manage and inspect spend limits, vendor checks, and compliance approval routing policies.</p>
      </div>
    </section>
    ${renderFeedback()}
    <div class="dashboard-grid">
      <div class="panel span-7">
        <div class="panel-heading"><h2>Active Policy Rules</h2></div>
        <div style="padding: 16px;">${renderPolicyRules()}</div>
      </div>
      <div class="panel span-5">
        <div class="panel-heading"><h2>Recent Policy Engine Checks</h2></div>
        <div class="policy-checks">
          ${dashboard().policyAudit.checks.map((check) => `
            <div class="policy-row">
              <span>▧ ${escapeHtml(check.summary)}</span>
              <strong class="${escapeHtml(check.result)}">${escapeHtml(titleCase(check.result))}</strong>
              <small>${escapeHtml(check.ago || "")}</small>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderSettingsPage() {
  const activeTab = state.currentRoute;
  el.app.className = "dashboard settings-page";
  
  let tabContent = "";
  if (activeTab === "settings") {
    tabContent = `
      <div class="dashboard-grid">
        <div class="span-6">
          ${renderIntakePanel(false)}
        </div>
        <div class="panel span-6" style="padding: 20px;">
          <h3 style="margin-top:0;">Dashboard Settings</h3>
          <p class="muted">Configure default workspace defaults and API options.</p>
          <div style="margin-top: 20px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 700;">Workspace Name</label>
            <input type="text" value="${escapeHtml(state.bootstrap.workspace?.name || 'Acme Corp')}" style="width: 100%; padding: 8px 12px; margin-bottom: 16px; border:1px solid var(--line); border-radius:10px;" readonly />
            
            <label style="display: block; margin-bottom: 8px; font-weight: 700;">Data Retention Period</label>
            <select style="width: 100%; padding: 8px 12px; margin-bottom: 16px; border:1px solid var(--line); border-radius:10px;" disabled>
              <option>${state.bootstrap.workspace?.retentionDays || 365} Days</option>
            </select>
            
            <label style="display: block; margin-bottom: 8px; font-weight: 700; margin-bottom: 8px;">Deployment Mode</label>
            <span class="badge status-completed">${escapeHtml(titleCase(state.bootstrap.workspace?.deploymentModel || 'Cloud SaaS'))}</span>
          </div>
        </div>
      </div>
    `;
  } else if (activeTab === "integrations") {
    tabContent = `
      <div class="panel span-12" style="padding: 20px;">
        <h2 style="margin-top:0;">Connected Enterprise Integrations</h2>
        <p class="muted">Governed procurement connectors and channels.</p>
        <div class="grid-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 20px;">
          ${(state.bootstrap.toolConnectors || []).map(conn => `
            <div class="card" style="border: 1px solid var(--line); border-radius: 12px; padding: 16px; background: #fff; box-shadow: var(--shadow);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                <strong>${escapeHtml(conn.name)}</strong>
                <span class="badge ${conn.status === 'connected' ? 'status-running' : 'muted-badge'}">${escapeHtml(titleCase(conn.status))}</span>
              </div>
              <p style="margin: 0 0 12px; font-size: 12px; color: var(--muted);">Type: ${escapeHtml(conn.type ? titleCase(conn.type) : 'Connector')}</p>
              <div style="font-size: 11px; color: var(--text);">
                <strong>Actions:</strong> ${conn.governedActions.map(a => `<code>${escapeHtml(a)}</code>`).join(", ")}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  } else if (activeTab === "people") {
    tabContent = `
      <div class="panel span-12" style="padding: 20px;">
        <h2 style="margin-top:0;">People & Team Members</h2>
        <p class="muted">Governed team roles and routing permissions.</p>
        <div class="table-card" style="margin-top: 20px;">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Department</th>
                <th>Authorized Roles</th>
              </tr>
            </thead>
            <tbody>
              ${users().map(user => `
                <tr>
                  <td><span class="owner-chip">${escapeHtml(initials(user.name))}</span><strong>${escapeHtml(user.name)}</strong></td>
                  <td>${escapeHtml(user.email)}</td>
                  <td>${escapeHtml(user.department)}</td>
                  <td>${user.roles.map(r => `<span class="badge muted-badge" style="margin-right: 4px;">${escapeHtml(r)}</span>`).join("")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  el.app.innerHTML = `
    <section class="page-header">
      <div>
        <h1>Admin Control Panel</h1>
        <p>Configure platform preferences, manage team members, and inspect connected enterprise integrations.</p>
      </div>
    </section>
    <div class="tabs" style="border-top: none; margin-bottom: 20px; padding: 0;">
      <a href="#settings" class="tab-btn ${activeTab === 'settings' ? 'active' : ''}" style="padding: 8px 16px; font-weight: 700; border-bottom: 2px solid ${activeTab === 'settings' ? 'var(--blue)' : 'transparent'}; color: ${activeTab === 'settings' ? 'var(--blue)' : 'var(--muted)'};">⚙ Settings</a>
      <a href="#integrations" class="tab-btn ${activeTab === 'integrations' ? 'active' : ''}" style="padding: 8px 16px; font-weight: 700; border-bottom: 2px solid ${activeTab === 'integrations' ? 'var(--blue)' : 'transparent'}; color: ${activeTab === 'integrations' ? 'var(--blue)' : 'var(--muted)'};">⛓ Integrations</a>
      <a href="#people" class="tab-btn ${activeTab === 'people' ? 'active' : ''}" style="padding: 8px 16px; font-weight: 700; border-bottom: 2px solid ${activeTab === 'people' ? 'var(--blue)' : 'transparent'}; color: ${activeTab === 'people' ? 'var(--blue)' : 'var(--muted)'};">♙ People & Teams</a>
    </div>
    ${tabContent}
  `;
}

function renderAnalyticsPage() {
  const analytics = dashboard().analytics || { spendBuckets: [], efficiency: [] };
  const spendBuckets = analytics.spendBuckets || [];
  const efficiency = analytics.efficiency || [];
  const hasSpend = spendBuckets.some((bucket) => bucket.count > 0);
  const spendBars = hasSpend
    ? spendBuckets
        .map((bucket) => '<div style="background: var(--' + escapeHtml(bucket.tone) + '); height: ' + Number(bucket.heightPercent || 0) + '%; border-radius: 4px 4px 0 0;" title="' + escapeHtml(bucket.label + ': $' + Number(bucket.totalSpend || 0).toLocaleString()) + '"></div>')
        .join("")
    : '<p class="empty-copy" style="grid-column: 1 / -1; align-self:center;">Not enough spend data yet.</p>';
  const spendLabels = spendBuckets.length
    ? spendBuckets.map((bucket) => '<span>' + escapeHtml(bucket.label) + '<br><strong>$' + escapeHtml(Number(bucket.totalSpend || 0).toLocaleString()) + '</strong></span>').join("")
    : '<span>Not enough data yet</span>';
  const efficiencyRows = efficiency.length
    ? efficiency
        .map((metric) => {
          const value = metric.value;
          const display = value === null || value === undefined ? "Not enough data" : value + "%";
          const width = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, Number(value)));
          return '<div><div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;"><span>' + escapeHtml(metric.label) + '</span><strong>' + escapeHtml(display) + '</strong></div><div style="background:#e5e7eb; height:8px; border-radius:4px; overflow:hidden;"><div style="background:var(--' + escapeHtml(metric.tone) + '); width:' + width + '%; height:100%;"></div></div></div>';
        })
        .join("")
    : '<p class="empty-copy">Not enough efficiency data yet.</p>';

  el.app.className = "dashboard analytics-page";
  el.app.innerHTML = `
    <section class="page-header">
      <div>
        <h1>System Analytics</h1>
        <p>Analyze performance metrics, response times, and governance compliance rates.</p>
      </div>
    </section>
    ${renderFeedback()}
    <section class="metric-grid" aria-label="Metrics">${renderHomeMetrics()}</section>
    <div class="dashboard-grid">
      <div class="panel span-6" style="padding: 20px;">
        <h3 style="margin-top:0;">Spend vs Thresholds</h3>
        <p class="muted">Procurement requests classified by total amount.</p>
        <div style="height: 200px; display: grid; align-items: end; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 20px 0; border-bottom: 2px solid var(--line);">
          ${spendBars}
        </div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; font-size: 11px; margin-top: 8px;">
          ${spendLabels}
        </div>
      </div>
      <div class="panel span-6" style="padding: 20px;">
        <h3 style="margin-top:0;">Agent Efficiency</h3>
        <p class="muted">Triage confidence levels and response SLAs.</p>
        <div style="margin-top: 20px; display: grid; gap: 14px;">
          ${efficiencyRows}
        </div>
      </div>
    </div>
  `;
}

function renderHomePage() {
  const focus = state.currentRoute;
  const policyFocused = focus === "policyAudit" || focus === "audit" || focus === "analytics";
  el.app.className = "dashboard";
  el.app.innerHTML =
    '<section class="utility-row">' +
    "<div></div>" +
    '<label class="date-filter" title="Date range filtering is not available in the in-memory demo data">📅<select disabled aria-disabled="true"><option>Demo data range</option></select></label>' +
    '<button class="icon-button"' + actionAttrs("refresh", "refresh") + ">↻</button>" +
    "</section>" +
    renderFeedback() +
    '<section class="metric-grid" aria-label="Metrics">' + renderHomeMetrics() + "</section>" +
    '<section class="dashboard-grid">' +
    renderWorkboardPanel(focus === "workboard") +
    renderCompactAgentRunsPanel() +
    renderTimelinePanel() +
    renderPolicyPanel(policyFocused) +
    renderArtifactsPanel(focus === "artifacts") +
    "</section>" +
    renderIntakePanel(focus === "settings");
}

function renderHomeMetrics() {
  return dashboard()
    .metrics.map((metric) => {
      const deltaClass = metric.delta.startsWith("↓") ? "negative" : "positive";
      return (
        '<article class="metric-card">' +
        '<div class="metric-icon ' + escapeHtml(metric.tone) + '">' + escapeHtml(metric.icon) + "</div>" +
        "<div><span>" + escapeHtml(metric.label) + "</span><strong>" + escapeHtml(metric.value) + '</strong><small class="' + deltaClass + '">' + escapeHtml(metric.delta) + "</small></div>" +
        '<svg viewBox="0 0 120 34" aria-hidden="true"><polyline points="2,27 18,21 32,24 47,14 64,23 80,10 98,18 118,16" /></svg>' +
        "</article>"
      );
    })
    .join("");
}

function renderWorkboardPanel(focused) {
  const rows = dashboard().workItems.slice(0, 7);
  return (
    '<article id="workboard" class="panel span-7' + (focused ? " focus-panel" : "") + '">' +
    '<div class="panel-heading"><h2>Live Workboard <span class="count-badge">' + rows.length + '</span></h2><a href="#workboard">View all</a></div>' +
    '<div class="table-card"><table><thead><tr><th>Title</th><th>Owner</th><th>Assigned Agent</th><th>Status</th><th>Risk</th><th>Last Updated</th></tr></thead><tbody>' +
    rows
      .map((row) => {
        return (
          "<tr>" +
          '<td><span class="doc-icon">▧</span>' + escapeHtml(row.title) + "</td>" +
          '<td><span class="owner-chip">' + escapeHtml(row.ownerInitials) + "</span>" + escapeHtml(row.owner) + "</td>" +
          "<td>🤖 " + escapeHtml(row.assignedAgent) + "</td>" +
          "<td>" + statusBadge(row.status) + "</td>" +
          "<td>" + riskBadge(row.risk) + "</td>" +
          "<td>" + escapeHtml(row.lastUpdated) + "</td>" +
          "</tr>"
        );
      })
      .join("") +
    '</tbody></table><div class="table-footer">Showing 1–' + rows.length + " of " + dashboard().workItems.length + " <span>‹ 1 ›</span></div></div></article>"
  );
}

function renderCompactAgentRunsPanel() {
  const runs = dashboard().agentRuns;
  const active = runs.filter((run) => run.status !== "completed").length;
  return (
    '<article class="panel span-5">' +
    '<div class="panel-heading"><h2>Agent Runs <span class="count-badge">' + active + ' active</span></h2><a href="#agentRuns">View all</a></div>' +
    '<div class="agent-run-list">' +
    runs
      .slice(0, 7)
      .map((run) => renderCompactAgentRun(run))
      .join("") +
    '</div><a class="panel-footer-link" href="#agentRuns">View all agent runs</a></article>'
  );
}

function renderCompactAgentRun(run) {
  const actionKey = "simulate:" + run.id;
  return (
    '<div class="agent-run" data-agent-run-id="' + escapeHtml(run.id) + '">' +
    '<div class="run-avatar">' + escapeHtml(run.agentName.slice(0, 2).toUpperCase()) + "</div>" +
    '<div class="agent-run-main"><div class="agent-run-heading"><strong>' + escapeHtml(run.agentName) + "</strong>" + statusBadge(run.status) + "</div>" +
    "<p>" + escapeHtml(run.role) + "</p>" +
    '<div class="progress-row"><div class="progress"><span style="width: ' + Number(run.progress) + '%"></span></div><small>' + Number(run.progress) + "%</small></div>" +
    (run.waitingOn ? '<small class="muted">Waiting on: ' + escapeHtml(run.waitingOn) + "</small>" : "") +
    "</div>" +
    '<button class="simulate-button"' + actionAttrs("simulate", actionKey, run.status === "completed" ? 'disabled title="Completed runs cannot be simulated again"' : "") + ">" + (state.loadingAction === actionKey ? "..." : "Sim") + "</button>" +
    "</div>"
  );
}

function renderTimelinePanel() {
  return (
    '<article class="panel span-4"><div class="panel-heading"><h2>Shared Timeline</h2><span class="live-dot">● Live</span></div>' +
    '<div class="timeline">' +
    dashboard()
      .timeline.slice(0, 8)
      .map((event) => renderTimelineItem(event))
      .join("") +
    '</div><a class="panel-footer-link" href="#agentRuns">View full timeline</a></article>'
  );
}

function renderPolicyPanel(focused) {
  const summary = dashboard().policyAudit.summary;
  return (
    '<article id="policyAudit" class="panel span-4' + (focused ? " focus-panel" : "") + '">' +
    '<div class="panel-heading"><h2>Policy & Audit</h2><a href="#policyAudit">View all</a></div>' +
    '<div class="tabs"><button class="active" disabled aria-disabled="true" title="Current panel view">Policy Checks</button><button disabled aria-disabled="true" title="Use run trace or artifact audit drawers for audit details">Audit Log</button></div>' +
    '<div class="policy-summary"><div><span>All Checks</span><strong>' + summary.allChecks + "</strong></div><div><span>Allowed</span><strong>" + summary.allowed + "</strong></div><div><span>Blocked</span><strong>" + summary.blocked + "</strong></div><div><span>Alerts</span><strong>" + summary.alerts + "</strong></div></div>" +
    '<div class="policy-checks">' +
    dashboard()
      .policyAudit.checks.map((check) => '<div class="policy-row"><span>▧ ' + escapeHtml(check.summary) + '</span><strong class="' + escapeHtml(check.result) + '">' + escapeHtml(titleCase(check.result)) + "</strong><small>" + escapeHtml(check.ago || "") + "</small></div>")
      .join("") +
    '</div>' +
    renderPolicyRules() +
    '<a class="panel-footer-link" href="#policyAudit">View all policy checks</a></article>'
  );
}

function renderPolicyRules() {
  const rules = state.bootstrap.policyRules || [];
  if (!rules.length) return "";
  return (
    '<div class="policy-rules"><h3>Policy Rules</h3>' +
    rules
      .map((rule) => {
        const key = "policy:" + rule.id;
        const stateLabel = rule.enabled ? "Enabled" : "Disabled";
        const toggle = canUpdatePolicy()
          ? '<button class="policy-toggle"' + actionAttrs("toggle-policy-rule", key, 'data-policy-rule-id="' + escapeHtml(rule.id) + '"') + ">" + (state.loadingAction === key ? "Saving..." : rule.enabled ? "Disable" : "Enable") + "</button>"
          : "";
        return '<div class="policy-rule-row"><div><strong>' + escapeHtml(rule.name) + '</strong><p>' + escapeHtml(rule.reason || "Policy rule") + '</p></div>' + smallBadge(stateLabel, rule.enabled ? "allowed" : "muted-badge") + toggle + "</div>";
      })
      .join("") +
    "</div>"
  );
}

function renderArtifactsPanel(focused) {
  return (
    '<article id="artifacts" class="panel span-5' + (focused ? " focus-panel" : "") + '">' +
    '<div class="panel-heading"><h2>Artifacts</h2><a href="#artifacts">View all</a></div>' +
    '<div class="table-card"><table><thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Updated</th></tr></thead><tbody>' +
    dashboard()
      .artifacts.slice(0, 8)
      .map((artifact) => "<tr><td><span class=\"doc-icon\">▧</span>" + escapeHtml(artifact.name) + "</td><td>" + escapeHtml(artifact.type) + "</td><td>🤖 " + escapeHtml(artifact.owner) + "</td><td>" + escapeHtml(artifact.updated) + "</td></tr>")
      .join("") +
    '</tbody></table></div><a class="panel-footer-link" href="#artifacts">View all artifacts</a></article>'
  );
}

function artifactBadge(label, category, key) {
  return '<span class="badge ' + escapeHtml(category) + "-" + escapeHtml(slug(key || label)) + '">' + escapeHtml(label) + "</span>";
}

function artifactIcon(artifact) {
  const type = artifact.typeKey || slug(artifact.type);
  if (type.includes("presentation")) return "▥";
  if (type.includes("spreadsheet") || type.includes("workbook")) return "▦";
  if (type.includes("proposal")) return "▤";
  if (type.includes("execution")) return "▣";
  if (type.includes("audit")) return "◉";
  if (type.includes("report")) return "▧";
  return "▧";
}

function renderArtifactsPage() {
  const rows = filteredArtifacts();
  ensureSelectedArtifact(rows);
  el.app.className = "dashboard artifacts-page";
  el.app.innerHTML =
    '<section class="page-header artifact-page-header">' +
    '<div><h1>Artifacts</h1><p>Browse enterprise outputs, documents, reports, and generated assets with policy-aware access and full audit history.</p></div>' +
    '<div class="page-actions">' + comingSoonButton("＋ Upload Artifact", "primary-button") + comingSoonButton("▱ Create Folder") + comingSoonButton("⇩ Export") + "</div>" +
    "</section>" +
    renderFeedback() +
    '<section class="artifact-metric-grid">' + renderArtifactMetrics() + "</section>" +
    '<section class="artifacts-workspace">' +
    '<div class="artifacts-main">' + renderArtifactFilters() + renderArtifactTable(rows) + renderArtifactHealth() + "</div>" +
    renderArtifactDrawer() +
    "</section>";
}

function renderArtifactMetrics() {
  const artifacts = enrichedArtifacts();
  const count = (predicate) => artifacts.filter(predicate).length;
  const avgSeconds = artifacts.length ? Math.max(42, Math.round(72 + artifacts.length * 4)) : 0;
  const metrics = [
    { label: "Total Artifacts", value: artifacts.length.toLocaleString(), delta: "↑ 14% vs last 30 days", tone: "blue", icon: "▧" },
    { label: "Shared Externally", value: count((artifact) => artifact.access === "shared" || artifact.access === "external").toLocaleString(), delta: "↑ 8% vs last 30 days", tone: "green", icon: "⌘" },
    { label: "Restricted", value: count((artifact) => artifact.access === "restricted" || artifact.classification === "highly_restricted").toLocaleString(), delta: "↑ 6% vs last 30 days", tone: "amber", icon: "▣" },
    { label: "Pending Review", value: count((artifact) => artifact.needsReview).toLocaleString(), delta: "↑ 16% vs last 30 days", tone: "purple", icon: "◷" },
    { label: "Policy Flags", value: count((artifact) => artifact.policyStatus === "flagged" || artifact.policyStatus === "blocked").toLocaleString(), delta: "↓ 9% vs last 30 days", tone: "red", icon: "⚑" },
    { label: "Avg Access Time", value: Math.floor(avgSeconds / 60) + "m " + String(avgSeconds % 60).padStart(2, "0") + "s", delta: "↓ 12% vs last 30 days", tone: "blue", icon: "⏱" }
  ];
  return metrics
    .map(
      (metric) =>
        '<article class="artifact-metric-card">' +
        '<div class="metric-icon ' + escapeHtml(metric.tone) + '">' + escapeHtml(metric.icon) + "</div>" +
        "<div><span>" + escapeHtml(metric.label) + "</span><strong>" + escapeHtml(metric.value) + '</strong><small class="' + (metric.delta.startsWith("↓") ? "negative" : "positive") + '">' + escapeHtml(metric.delta) + "</small></div>" +
        '<svg viewBox="0 0 90 28" aria-hidden="true"><polyline points="2,22 14,17 24,20 36,11 48,18 61,8 75,13 88,10" /></svg>' +
        "</article>"
    )
    .join("");
}

function renderArtifactFilters() {
  const artifacts = enrichedArtifacts();
  const filters = state.artifactFilters;
  const types = artifacts.map((artifact) => ({ value: artifact.typeKey, label: artifact.type }));
  const classifications = artifacts.map((artifact) => ({ value: artifact.classification, label: artifact.classificationLabel }));
  const owners = artifacts.map((artifact) => ({ value: artifact.owner, label: artifact.owner }));
  const access = artifacts.map((artifact) => ({ value: artifact.access, label: artifact.accessLabel }));
  const policyStatuses = artifacts.map((artifact) => ({ value: artifact.policyStatus, label: artifact.policyStatusLabel }));
  const departments = artifacts.map((artifact) => ({ value: artifact.department, label: artifact.department }));
  return (
    '<div class="artifact-filters">' +
    '<input class="artifact-search-input" data-artifact-search type="search" placeholder="Search artifacts, work items, owners, tags..." value="' + escapeHtml(filters.search) + '" />' +
    '<label>Type<select data-artifact-filter="type">' + selectOptions(types, filters.type, "All") + "</select></label>" +
    '<label>Classification<select data-artifact-filter="classification">' + selectOptions(classifications, filters.classification, "All") + "</select></label>" +
    '<label>Owner<select data-artifact-filter="owner">' + selectOptions(owners, filters.owner, "All") + "</select></label>" +
    '<label>Access<select data-artifact-filter="access">' + selectOptions(access, filters.access, "All") + "</select></label>" +
    '<label>Policy Status<select data-artifact-filter="policyStatus">' + selectOptions(policyStatuses, filters.policyStatus, "All") + "</select></label>" +
    '<label>Department<select data-artifact-filter="department">' + selectOptions(departments, filters.department, "All") + "</select></label>" +
    '<label>Date<select data-artifact-filter="date"><option value="any">Any</option><option value="today"' + (filters.date === "today" ? " selected" : "") + '>Last 24h</option><option value="week"' + (filters.date === "week" ? " selected" : "") + '>Last 7d</option><option value="month"' + (filters.date === "month" ? " selected" : "") + ">Last 30d</option></select></label>" +
    '<label>Needs Review<select data-artifact-filter="needsReview"><option value="all">All</option><option value="yes"' + (filters.needsReview === "yes" ? " selected" : "") + '>Yes</option><option value="no"' + (filters.needsReview === "no" ? " selected" : "") + ">No</option></select></label>" +
    '<label>SLA<select data-artifact-filter="sla"><option value="all">All</option><option value="healthy"' + (filters.sla === "healthy" ? " selected" : "") + '>Healthy</option><option value="breached"' + (filters.sla === "breached" ? " selected" : "") + ">Breached</option></select></label>" +
    '<label>Sort<select data-artifact-filter="sortKey"><option value="updated"' + (filters.sortKey === "updated" ? " selected" : "") + '>Last updated</option><option value="name"' + (filters.sortKey === "name" ? " selected" : "") + '>Name</option><option value="policyStatus"' + (filters.sortKey === "policyStatus" ? " selected" : "") + '>Policy status</option><option value="classification"' + (filters.sortKey === "classification" ? " selected" : "") + '>Classification</option><option value="owner"' + (filters.sortKey === "owner" ? " selected" : "") + ">Owner</option></select></label>" +
    '<label>Order<select data-artifact-filter="sortDirection"><option value="desc"' + (filters.sortDirection === "desc" ? " selected" : "") + '>Desc</option><option value="asc"' + (filters.sortDirection === "asc" ? " selected" : "") + ">Asc</option></select></label>" +
    '<button' + actionAttrs("clear-artifact-filters", "clear-artifact-filters") + ">Clear</button>" +
    "</div>"
  );
}

function renderArtifactTable(rows) {
  if (!rows.length) {
    return '<div class="panel artifact-table-panel empty-artifacts"><p class="empty-copy">No artifacts match the current filters.</p></div>';
  }
  return (
    '<div class="panel artifact-table-panel"><table class="artifact-table"><thead><tr><th>Name</th><th>Type</th><th>Linked Work Item</th><th>Owner</th><th>Classification</th><th>Access</th><th>Policy Status</th><th>Versions</th><th>Last Updated</th><th>Actions</th></tr></thead><tbody>' +
    rows
      .map((artifact) => {
        const selected = artifact.id === state.selectedArtifactId ? " selected-row" : "";
        return (
          '<tr class="artifact-row' + selected + '" data-artifact-id="' + escapeHtml(artifact.id) + '">' +
          '<td><span class="doc-icon artifact-doc-icon">' + artifactIcon(artifact) + '</span><strong>' + escapeHtml(artifact.name) + '</strong></td>' +
          "<td>" + escapeHtml(artifact.type) + "</td>" +
          '<td><a href="#agentRuns">' + escapeHtml(artifact.linkedWorkItemTitle || "—") + "</a></td>" +
          '<td><span class="owner-chip">' + escapeHtml(initials(artifact.owner)) + "</span>" + escapeHtml(artifact.owner) + "</td>" +
          "<td>" + artifactBadge(artifact.classificationLabel, "classification", artifact.classification) + "</td>" +
          "<td>" + artifactBadge(artifact.accessLabel, "access", artifact.access) + "</td>" +
          "<td>" + artifactBadge(artifact.policyStatusLabel, "policy", artifact.policyStatus) + "</td>" +
          "<td>" + escapeHtml(artifact.version || "v1") + "</td>" +
          "<td>" + escapeHtml(artifact.updated || relativeTime(artifact.updatedAt)) + "</td>" +
          '<td><button class="table-action-button" data-action="select-artifact" data-artifact-id="' + escapeHtml(artifact.id) + '">···</button></td>' +
          "</tr>"
        );
      })
      .join("") +
    '</tbody></table><div class="table-footer">Showing 1–' + rows.length + " of " + enrichedArtifacts().length + '<span class="pager">‹ <b>1</b> ›</span></div></div>'
  );
}

function renderArtifactHealth() {
  const artifacts = enrichedArtifacts();
  const reviewQueue = artifacts.filter((artifact) => artifact.needsReview).slice(0, 5);
  const policyEvents = artifacts.flatMap((artifact) => artifact.auditEvents || []).sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, 5);
  const count = (predicate) => artifacts.filter(predicate).length;
  const internal = count((artifact) => artifact.classification === "internal");
  const confidential = count((artifact) => artifact.classification === "confidential");
  const restricted = count((artifact) => artifact.classification === "highly_restricted");
  const pending = count((artifact) => artifact.needsReview);
  const checks = artifacts.flatMap((artifact) => artifact.policyChecks || []);
  const allowed = checks.filter((check) => check.result === "allowed").length;
  const blocked = checks.filter((check) => check.result === "blocked").length;
  const alerts = checks.filter((check) => check.result === "alert").length;
  return (
    '<section class="artifact-bottom-grid">' +
    '<article class="panel artifact-health-card"><h3>Artifact Health</h3><div class="artifact-donut"><strong>' + artifacts.length.toLocaleString() + '</strong><span>Total</span></div><div class="health-legend"><span><i class="green-dot"></i>Internal ' + internal + '</span><span><i class="purple-dot"></i>Confidential ' + confidential + '</span><span><i class="red-dot"></i>Highly Restricted ' + restricted + '</span><span><i class="amber-dot"></i>Pending Review ' + pending + '</span></div><a class="panel-footer-link" href="#artifacts">View full breakdown →</a></article>' +
    '<article class="panel queue-card artifact-queue-card"><h3>Access Queue <span class="count-badge">' + reviewQueue.length + '</span><a href="#artifacts">View all →</a></h3>' +
    (reviewQueue.length ? reviewQueue.map((artifact) => '<div class="queue-row"><span>' + artifactIcon(artifact) + " " + escapeHtml(artifact.name) + '</span><strong>' + escapeHtml(initials(artifact.waitingOn || artifact.owner)) + '</strong><small>' + escapeHtml(artifact.waitingOn || artifact.owner) + '</small><small>' + escapeHtml(artifact.updated || "") + "</small></div>").join("") : '<p class="empty-copy">No access requests pending.</p>') +
    "</article>" +
    '<article class="panel queue-card artifact-policy-card"><h3>Policy & Audit <a href="#policyAudit">View all →</a></h3><div class="policy-summary artifact-policy-summary"><div><span>Total Checks</span><strong>' + checks.length + '</strong></div><div><span>Allowed</span><strong class="allowed">' + allowed + '</strong></div><div><span>Blocked</span><strong class="blocked">' + blocked + '</strong></div><div><span>Alerts</span><strong class="alert">' + alerts + '</strong></div></div>' +
    (policyEvents.length ? policyEvents.map((event) => '<div class="policy-row"><span>' + escapeHtml(event.action || event.type) + '</span><small>' + escapeHtml(event.ago || "") + "</small></div>").join("") : '<p class="empty-copy">No artifact audit events yet.</p>') +
    "</article>" +
    "</section>"
  );
}

function renderArtifactDrawer() {
  const artifact = selectedArtifact();
  if (!artifact) return '<aside class="artifact-detail-drawer panel"><p class="empty-copy">No artifact selected.</p></aside>';
  return (
    '<aside class="artifact-detail-drawer panel">' +
    '<div class="drawer-heading artifact-drawer-heading"><div><span class="doc-icon artifact-drawer-icon">' + artifactIcon(artifact) + '</span><h2>' + escapeHtml(artifact.name) + '</h2><div class="drawer-badges">' + artifactBadge(artifact.classificationLabel, "classification", artifact.classification) + artifactBadge(artifact.accessLabel, "access", artifact.access) + '</div></div><button data-action="close-artifact-drawer">×</button></div>' +
    renderArtifactFacts(artifact) +
    renderArtifactAccessPolicy(artifact) +
    renderArtifactTabs(artifact) +
    '<div class="detail-tab-body">' + renderSelectedArtifactTab(artifact) + "</div>" +
    "</aside>"
  );
}

function renderArtifactFacts(artifact) {
  return (
    '<dl class="run-facts artifact-facts">' +
    "<div><dt>Type</dt><dd>" + escapeHtml(artifact.type) + "</dd></div>" +
    '<div><dt>Linked Work Item</dt><dd><a href="#agentRuns">' + escapeHtml(artifact.linkedWorkItemTitle || "—") + "</a></dd></div>" +
    "<div><dt>Owner</dt><dd>" + escapeHtml(artifact.owner) + "</dd></div>" +
    "<div><dt>Created by</dt><dd>" + escapeHtml(artifact.createdBy || artifact.owner) + "</dd></div>" +
    "<div><dt>Last Updated</dt><dd>" + escapeHtml(artifact.updated || relativeTime(artifact.updatedAt)) + "</dd></div>" +
    "<div><dt>Version</dt><dd>" + escapeHtml(artifact.version || "v1") + "</dd></div>" +
    "<div><dt>Data Source</dt><dd>" + escapeHtml(artifact.dataSource || "System") + "</dd></div>" +
    "</dl>"
  );
}

function renderArtifactAccessPolicy(artifact) {
  return (
    '<section class="artifact-access-policy">' +
    "<h3>◇ Access & Policy</h3>" +
    '<dl class="artifact-policy-list">' +
    "<div><dt>Current Access</dt><dd>" + artifactBadge(artifact.accessLabel, "access", artifact.access) + "</dd></div>" +
    "<div><dt>Approved Audience</dt><dd>" + escapeHtml(artifact.approvedAudience || "Team members") + "</dd></div>" +
    "<div><dt>Sharing Policy</dt><dd>" + escapeHtml(artifact.sharingPolicy || "Internal sharing allowed") + "</dd></div>" +
    "<div><dt>Retention Policy</dt><dd>" + escapeHtml(artifact.retentionPolicy || "7 years") + "</dd></div>" +
    "<div><dt>Policy Classification</dt><dd>" + artifactBadge(artifact.policyClassification || artifact.classificationLabel, "classification", artifact.classification) + "</dd></div>" +
    "</dl>" +
    '<div class="artifact-actions">' + comingSoonButton("🔗 Request Access", "primary-button") + comingSoonButton("⌘ Share") + comingSoonButton("⇩ Download") + '<button data-action="view-artifact-audit">◉ View Audit</button></div>' +
    "</section>"
  );
}

function renderArtifactTabs(artifact) {
  const tabs = ["overview", "preview", "access", "policy", "audit", "versions"];
  const counts = {
    policy: artifact.policyChecks?.length || 0,
    audit: artifact.auditEvents?.length || 0,
    versions: Number(String(artifact.version || "v1").replace("v", "")) || 1
  };
  return '<nav class="detail-tabs">' + tabs.map((tab) => '<button class="' + (state.selectedArtifactTab === tab ? "active" : "") + '" data-artifact-tab="' + tab + '">' + escapeHtml(titleCase(tab)) + (counts[tab] ? ' <span class="tab-count">' + counts[tab] + "</span>" : "") + "</button>").join("") + "</nav>";
}

function renderSelectedArtifactTab(artifact) {
  if (state.selectedArtifactTab === "preview") return renderArtifactPreview(artifact);
  if (state.selectedArtifactTab === "access") return renderArtifactAccessTab(artifact);
  if (state.selectedArtifactTab === "policy") return renderArtifactPolicyTab(artifact);
  if (state.selectedArtifactTab === "audit") return renderArtifactAuditTab(artifact);
  if (state.selectedArtifactTab === "versions") return renderArtifactVersionsTab(artifact);
  return renderArtifactOverviewTab(artifact);
}

function renderArtifactOverviewTab(artifact) {
  return (
    '<div class="overview-grid">' +
    "<div><span>Department</span><strong>" + escapeHtml(artifact.department) + "</strong></div>" +
    "<div><span>Policy Status</span><strong>" + escapeHtml(artifact.policyStatusLabel) + "</strong></div>" +
    "<div><span>Content Hash</span><strong>" + escapeHtml(String(artifact.contentHash || "").slice(0, 10)) + "</strong></div>" +
    "<div><span>SLA</span><strong>" + escapeHtml(titleCase(artifact.slaStatus)) + "</strong></div>" +
    "</div>" +
    '<p class="artifact-summary-copy">' + escapeHtml(artifact.summary || "Governed artifact generated from an enterprise workflow run.") + "</p>"
  );
}

function renderArtifactPreview(artifact) {
  return (
    '<div class="artifact-preview-layout">' +
    '<div class="artifact-preview-card"><strong>' + escapeHtml(artifact.name) + '</strong><span></span><span></span><span></span><span class="short"></span><span></span><span class="short"></span>' +
    (artifact.needsReview ? '<em>⚠ Contains policy-sensitive content</em>' : '<em class="allowed">✓ No active content warnings</em>') +
    "</div>" +
    '<div class="policy-summary artifact-preview-checks"><div><span>Allowed</span><strong class="allowed">' + (artifact.policyChecks || []).filter((check) => check.result === "allowed").length + '</strong></div><div><span>Blocked</span><strong class="blocked">' + (artifact.policyChecks || []).filter((check) => check.result === "blocked").length + '</strong></div><div><span>Alerts</span><strong class="alert">' + (artifact.policyChecks || []).filter((check) => check.result === "alert").length + "</strong></div></div>" +
    "</div>"
  );
}

function renderArtifactAccessTab(artifact) {
  return (
    '<div class="detail-row"><div><strong>Current access</strong><p>' + escapeHtml(artifact.accessLabel) + '</p></div>' + artifactBadge(artifact.accessLabel, "access", artifact.access) + "</div>" +
    '<div class="detail-row"><div><strong>Approved audience</strong><p>' + escapeHtml(artifact.approvedAudience || "Team members") + "</p></div></div>" +
    '<div class="detail-row"><div><strong>Sharing policy</strong><p>' + escapeHtml(artifact.sharingPolicy || "Internal sharing allowed") + "</p></div></div>"
  );
}

function renderArtifactPolicyTab(artifact) {
  const checks = artifact.policyChecks || [];
  if (!checks.length) return '<p class="empty-copy">No policy checks for this artifact yet.</p>';
  return checks.map((check) => '<div class="detail-row"><div><strong>' + escapeHtml(check.summary) + '</strong><p>' + escapeHtml(check.action) + '</p></div><strong class="' + escapeHtml(check.result) + '">' + escapeHtml(titleCase(check.result)) + "</strong></div>").join("");
}

function renderArtifactAuditTab(artifact) {
  const events = artifact.auditEvents || [];
  if (!events.length) return '<p class="empty-copy">No audit events for this artifact yet.</p>';
  return '<div class="artifact-audit-timeline">' + events.map((event) => '<div class="artifact-audit-event"><i></i><span>' + escapeHtml(formatClock(event.occurredAt)) + '</span><div><strong>' + escapeHtml(event.action || event.type) + '</strong><p>' + escapeHtml(event.summary || "") + '</p></div><small>' + escapeHtml(event.actor || "") + "</small></div>").join("") + "</div>";
}

function renderArtifactVersionsTab(artifact) {
  const current = Number(String(artifact.version || "v1").replace("v", "")) || 1;
  const versions = Array.from({ length: Math.min(current, 5) }, (_, index) => current - index);
  return versions.map((version, index) => '<div class="detail-row"><div><strong>v' + version + (index === 0 ? " Current" : "") + '</strong><p>' + escapeHtml(index === 0 ? "Latest governed version" : "Historical retained version") + '</p></div><small>' + escapeHtml(index === 0 ? artifact.updated || relativeTime(artifact.updatedAt) : version + "h ago") + "</small></div>").join("");
}

function renderIntakePanel(focused) {
  return (
    '<section id="settings" class="quick-intake panel' + (focused ? " focus-panel" : "") + '">' +
    '<div><p class="eyebrow">Demo control</p><h2>Create procurement work item</h2></div>' +
    '<form id="requestForm" class="quick-form">' +
    '<input name="vendor" placeholder="Vendor" value="Atlas Cloud" required />' +
    '<input name="amount" type="number" placeholder="Amount" value="12500" required />' +
    '<input name="department" placeholder="Department" value="Operations" required />' +
    '<select name="vendorRisk"><option value="low">low risk</option><option value="medium">medium risk</option><option value="high" selected>high risk</option><option value="sanctioned">sanctioned</option></select>' +
    '<input name="category" placeholder="Category" value="software" />' +
    '<button type="submit">Create</button></form></section>'
  );
}

function renderAgentRunsPage() {
  const rows = filteredRuns();
  el.app.className = "dashboard agent-runs-page";
  el.app.innerHTML =
    '<section class="page-header">' +
    '<div><h1>Agent Runs</h1><p>Monitor live agent execution, blockers, approvals, and risk across the enterprise.</p></div>' +
    '<div class="page-actions"><button class="primary-button" data-action="create-run">＋ Create Run</button>' + (canReadAudit() ? '<button' + actionAttrs("export-audit", "export-audit") + '>⇩ Export</button>' : "") + comingSoonButton("··· More") + "</div>" +
    "</section>" +
    renderFeedback() +
    '<section class="run-metric-grid">' + renderRunMetrics() + "</section>" +
    '<section class="agent-runs-workspace">' +
    '<div class="runs-main">' + renderRunFilters() + renderRunTable(rows) + renderRunHealth() + "</div>" +
    renderRunDrawer() +
    "</section>";
}

function renderRunMetrics() {
  const runs = enrichedRuns();
  const count = (predicate) => runs.filter(predicate).length;
  const avg = runs.length ? Math.round(runs.reduce((sum, item) => sum + durationMinutes(item), 0) / runs.length) : 0;
  const metrics = [
    { label: "Total Runs", value: runs.length, delta: "↑ 18% vs yesterday", tone: "blue", icon: "▷" },
    { label: "Running", value: count((item) => item.status === "running"), delta: "↑ 9% vs yesterday", tone: "green", icon: "↯" },
    { label: "Waiting for Human", value: count((item) => item.approvals.length > 0 || item.status === "waiting_for_human"), delta: "↑ 13% vs yesterday", tone: "amber", icon: "♙" },
    { label: "Waiting for Tool", value: count((item) => item.status === "waiting_for_tool"), delta: "↓ 2% vs yesterday", tone: "purple", icon: "⌁" },
    { label: "Policy Blocked", value: count((item) => item.run.status === "blocked" || item.status === "blocked"), delta: "↓ 25% vs yesterday", tone: "red", icon: "⬡" },
    { label: "Avg Duration", value: avg + "m", delta: "↓ 5% vs yesterday", tone: "blue", icon: "◷" }
  ];
  return metrics
    .map((metric) => '<article class="run-metric-card"><div class="metric-icon ' + metric.tone + '">' + metric.icon + '</div><div><span>' + metric.label + '</span><strong>' + metric.value + '</strong><small class="' + (metric.delta.startsWith("↓") ? "negative" : "positive") + '">' + metric.delta + "</small></div></article>")
    .join("");
}

function selectOptions(values, selected, allLabel) {
  const unique = [...new Map(values.filter(Boolean).map((item) => [item.value, item])).values()];
  return '<option value="all">' + allLabel + "</option>" + unique.map((item) => '<option value="' + escapeHtml(item.value) + '"' + (String(item.value) === String(selected) ? " selected" : "") + ">" + escapeHtml(item.label) + "</option>").join("");
}

function renderRunFilters() {
  const runs = enrichedRuns();
  const statuses = runs.flatMap((item) => [{ value: item.status, label: titleCase(item.status) }, { value: item.run.status, label: titleCase(item.run.status) }]);
  const agents = state.bootstrap.agents.map((agent) => ({ value: agent.id, label: agent.name }));
  const risks = ["low", "medium", "high", "sanctioned"].map((risk) => ({ value: risk, label: titleCase(risk) }));
  const owners = users().map((user) => ({ value: user.id, label: user.name }));
  const departments = [...new Set(runs.map((item) => item.department))].map((department) => ({ value: department, label: department }));
  return (
    '<div class="run-filters">' +
    '<input class="run-search" data-run-search type="search" placeholder="Search runs, work items, agents, owners..." value="' + escapeHtml(state.filters.search) + '" />' +
    '<label>Status<select data-filter="status">' + selectOptions(statuses, state.filters.status, "All") + "</select></label>" +
    '<label>Agent<select data-filter="agent">' + selectOptions(agents, state.filters.agent, "All") + "</select></label>" +
    '<label>Risk<select data-filter="risk">' + selectOptions(risks, state.filters.risk, "All") + "</select></label>" +
    '<label>Owner<select data-filter="owner">' + selectOptions(owners, state.filters.owner, "All") + "</select></label>" +
    '<label>Department<select data-filter="department">' + selectOptions(departments, state.filters.department, "All") + "</select></label>" +
    '<label>Duration<select data-filter="duration"><option value="any">Any</option><option value="under10"' + (state.filters.duration === "under10" ? " selected" : "") + '>Under 10m</option><option value="over10"' + (state.filters.duration === "over10" ? " selected" : "") + ">Over 10m</option></select></label>" +
    '<label>Needs Human Action<select data-filter="humanAction"><option value="all">All</option><option value="yes"' + (state.filters.humanAction === "yes" ? " selected" : "") + '>Yes</option><option value="no"' + (state.filters.humanAction === "no" ? " selected" : "") + ">No</option></select></label>" +
    '<label>SLA Breached<select data-filter="sla"><option value="all">All</option><option value="breached"' + (state.filters.sla === "breached" ? " selected" : "") + '>Breached</option><option value="healthy"' + (state.filters.sla === "healthy" ? " selected" : "") + ">Healthy</option></select></label>" +
    '<label>Sort<select data-filter="sortKey"><option value="lastUpdated"' + (state.filters.sortKey === "lastUpdated" ? " selected" : "") + '>Last updated</option><option value="duration"' + (state.filters.sortKey === "duration" ? " selected" : "") + '>Duration</option><option value="status"' + (state.filters.sortKey === "status" ? " selected" : "") + '>Status</option><option value="risk"' + (state.filters.sortKey === "risk" ? " selected" : "") + '>Risk</option><option value="progress"' + (state.filters.sortKey === "progress" ? " selected" : "") + ">Progress</option></select></label>" +
    '<label>Order<select data-filter="sortDirection"><option value="desc"' + (state.filters.sortDirection === "desc" ? " selected" : "") + '>Desc</option><option value="asc"' + (state.filters.sortDirection === "asc" ? " selected" : "") + ">Asc</option></select></label>" +
    '<button' + actionAttrs("clear-filters", "clear-filters") + ">Clear</button>" +
    "</div>"
  );
}

function renderRunTable(rows) {
  return (
    '<div class="panel run-table-panel"><table class="run-table"><thead><tr><th>Run Name</th><th>Work Item</th><th>Agent</th><th>Owner</th><th>Status</th><th>Current Step</th><th>Risk</th><th>Progress</th><th>Waiting On</th><th>Duration</th><th>Last Event</th><th>Actions</th></tr></thead><tbody>' +
    rows
      .map((item) => {
        const selected = item.run.id === state.selectedWorkflowRunId ? " selected-row" : "";
        const event = item.latestEvent;
        return (
          '<tr class="run-row' + selected + '" data-workflow-run-id="' + escapeHtml(item.run.id) + '">' +
          '<td><span class="doc-icon">▧</span>' + escapeHtml(item.run.title) + "</td>" +
          "<td>" + escapeHtml(item.agentRun?.role || item.run.type) + "</td>" +
          '<td><span class="owner-chip">' + escapeHtml(initials(item.agentRun?.agentName || "AG")) + "</span>" + escapeHtml(item.agentRun?.agentName || "Unassigned") + "</td>" +
          '<td><span class="owner-chip">' + escapeHtml(initials(item.owner?.name || "??")) + "</span>" + escapeHtml(item.owner?.name || "Unknown") + "</td>" +
          "<td>" + statusBadge(item.status) + "</td>" +
          "<td>" + escapeHtml(titleCase(item.run.currentStep)) + "</td>" +
          "<td>" + riskBadge(item.risk) + "</td>" +
          '<td><div class="progress-row compact-progress"><div class="progress"><span style="width: ' + item.progress + '%"></span></div><small>' + item.progress + "%</small></div></td>" +
          "<td>" + escapeHtml(item.waitingOn || "—") + "</td>" +
          "<td>" + escapeHtml(item.duration) + "</td>" +
          "<td><strong>" + escapeHtml(event?.action || "—") + "</strong><small>" + escapeHtml(event ? relativeTime(event.occurredAt) : "") + "</small></td>" +
          '<td><button class="table-action-button" data-action="select-run" data-workflow-run-id="' + escapeHtml(item.run.id) + '">···</button></td>' +
          "</tr>"
        );
      })
      .join("") +
    '</tbody></table><div class="table-footer">Showing 1–' + rows.length + " of " + enrichedRuns().length + '<span class="pager">‹ <b>1</b> 2 3 4 5 ··· 25 ›</span></div></div>'
  );
}

function renderRunHealth() {
  const runs = enrichedRuns();
  const waitingHuman = runs.filter((item) => item.approvals.length > 0 || item.status === "waiting_for_human").length;
  const waitingTool = runs.filter((item) => item.status === "waiting_for_tool").length;
  const completed = runs.filter((item) => item.status === "completed").length;
  const running = runs.filter((item) => item.status === "running").length;
  return (
    '<section class="run-bottom-grid">' +
    '<article class="panel run-health"><h3>Run Health</h3><div class="donut"><strong>' + runs.length + '</strong><span>Total Runs</span></div><div class="health-legend"><span><i class="green-dot"></i>Running ' + running + '</span><span><i class="amber-dot"></i>Waiting for Human ' + waitingHuman + '</span><span><i class="purple-dot"></i>Waiting for Tool ' + waitingTool + '</span><span><i class="gray-dot"></i>Completed ' + completed + "</span></div></article>" +
    renderToolActivityCard() +
    renderHumanQueueCard() +
    "</section>"
  );
}

function renderToolActivityCard() {
  const tools = state.bootstrap.toolConnectors.slice(0, 4);
  return '<article class="panel queue-card"><h3>Tool Activity <a href="#agentRuns">View all</a></h3>' + tools.map((tool, index) => '<div class="queue-row"><span>◉ ' + escapeHtml(tool.name) + '</span><strong>' + (8 - index) + '</strong><div class="success-bar"><span style="width: ' + (98 - index * 2) + '%"></span></div><small>' + (98 - index * 2) + "%</small></div>").join("") + "</article>";
}

function renderHumanQueueCard() {
  const queue = enrichedRuns().filter((item) => item.approvals.length > 0).slice(0, 4);
  return '<article class="panel queue-card"><h3>Human Action Queue <a href="#agentRuns">View queue</a></h3>' + queue.map((item) => '<div class="queue-row"><span><a href="#agentRuns" data-action="select-run" data-workflow-run-id="' + escapeHtml(item.run.id) + '">' + escapeHtml(item.run.title) + '</a></span><strong>' + escapeHtml(initials(item.waitingOn || "??")) + "</strong><small class=\"negative\">" + escapeHtml(dueIn(item.approvals[0]?.dueAt)) + "</small></div>").join("") + "</article>";
}

function renderRunDrawer() {
  const item = selectedRunItem();
  if (!item) return '<aside class="run-detail-drawer panel"><p class="muted">No run selected.</p></aside>';
  const run = item.run;
  const auditButton = canReadAudit() ? '<button class="drawer-audit-button" data-action="view-run-audit">View Audit</button>' : "";
  return (
    '<aside class="run-detail-drawer panel">' +
    '<div class="drawer-heading"><div><span class="live-dot">●</span><h2>' + escapeHtml(run.title) + '</h2><div class="drawer-badges">' + statusBadge(item.status) + riskBadge(item.risk) + '</div></div><div class="drawer-actions">' + auditButton + '<button data-action="close-drawer">×</button></div></div>' +
    renderRunFacts(item) +
    renderCurrentRequest(item) +
    renderDetailTabs() +
    '<div class="detail-tab-body">' + renderSelectedTab(item) + "</div>" +
    "</aside>"
  );
}

function renderRunFacts(item) {
  return (
    '<dl class="run-facts">' +
    "<div><dt>Agent</dt><dd>" + escapeHtml(item.agentRun?.agentName || "Unassigned") + "</dd></div>" +
    "<div><dt>Work Item</dt><dd>" + escapeHtml(item.agentRun?.role || item.run.type) + "</dd></div>" +
    "<div><dt>Owner</dt><dd>" + escapeHtml(item.owner?.name || "Unknown") + "</dd></div>" +
    "<div><dt>Risk</dt><dd>" + riskBadge(item.risk) + "</dd></div>" +
    "<div><dt>Started</dt><dd>" + escapeHtml(relativeTime(item.agentRun?.startedAt || item.run.createdAt)) + "</dd></div>" +
    "</dl>"
  );
}

function renderCurrentRequest(item) {
  const approval = item.approvals[0];
  if (!approval) return "";
  const approver = findUser(approval.requiredApprovers?.[0]?.userId);
  const actionKey = "approval:" + approval.id;
  const actions = canDecideApproval(approval)
    ? '<button class="approve-button"' + actionAttrs("approve", actionKey + ":approve", 'data-approval-id="' + escapeHtml(approval.id) + '"') + '>✓ Approve</button><button class="reject-button"' + actionAttrs("reject", actionKey + ":reject", 'data-approval-id="' + escapeHtml(approval.id) + '"') + ">⊗ Reject</button>"
    : '<p class="empty-copy">Only required approvers or admins can decide this request.</p>';
  return (
    '<section class="current-request">' +
    "<h3>ⓘ Current Request</h3>" +
    "<p>Approve " + escapeHtml(item.run.title.toLowerCase()) + " for governed execution.</p>" +
    "<small>Reason</small><strong>" + escapeHtml(approval.policyResult?.summary || approval.requiredApprovers?.[0]?.reason || "Policy requires human approval.") + "</strong>" +
    '<div class="approval-actions">' + actions + comingSoonButton("✎ Request Changes") + comingSoonButton("↗ Escalate") + "</div>" +
    '<div class="request-meta"><div><span>Required Authority</span><strong>' + escapeHtml(approval.requiredApprovers?.[0]?.role || "Approver") + '</strong></div><div><span>Due</span><strong class="negative">In ' + escapeHtml(dueIn(approval.dueAt)) + '</strong></div><div><span>Waiting On</span><strong>' + escapeHtml(approver?.name || item.waitingOn || "Approver") + "</strong></div></div>" +
    "</section>"
  );
}

function renderDetailTabs() {
  const tabs = ["overview", "timeline", "tools", "approvals", "artifacts", "policy", "trace"];
  return '<nav class="detail-tabs">' + tabs.map((tab) => '<button class="' + (state.selectedTab === tab ? "active" : "") + '" data-detail-tab="' + tab + '">' + escapeHtml(titleCase(tab)) + tabCount(tab) + "</button>").join("") + "</nav>";
}

function tabCount(tab) {
  const item = selectedRunItem();
  if (!item) return "";
  const counts = {
    approvals: item.run.approvalRequests?.length || 0,
    artifacts: item.run.evidenceArtifacts?.length || 0,
    tools: item.run.toolActionProposals?.length || 0
  };
  return counts[tab] ? ' <span class="tab-count">' + counts[tab] + "</span>" : "";
}

function renderSelectedTab(item) {
  if (state.selectedTab === "timeline") return renderRunTimeline(item.run);
  if (state.selectedTab === "tools") return renderToolsTab(item.run);
  if (state.selectedTab === "approvals") return renderApprovalsTab(item.run);
  if (state.selectedTab === "artifacts") return renderArtifactsTab(item.run);
  if (state.selectedTab === "policy") return renderPolicyTab(item.run);
  if (state.selectedTab === "trace") return renderTraceTab(item.run);
  return renderOverviewTab(item);
}

function renderOverviewTab(item) {
  return (
    '<div class="overview-grid">' +
    '<div><span>Current Step</span><strong>' + escapeHtml(titleCase(item.run.currentStep)) + '</strong></div>' +
    '<div><span>Progress</span><strong>' + item.progress + '%</strong></div>' +
    '<div><span>Duration</span><strong>' + escapeHtml(item.duration) + '</strong></div>' +
    '<div><span>Department</span><strong>' + escapeHtml(item.department) + '</strong></div>' +
    "</div>" +
    renderDelegationInline(item)
  );
}

function renderDelegationInline(item) {
  const proposal = item.run.toolActionProposals?.[0];
  const connector = state.bootstrap.toolConnectors.find((tool) => tool.id === proposal?.connectorId);
  return (
    '<section class="delegation-inline">' +
    '<div class="map-node human">👤<strong>' + escapeHtml(item.owner?.name || "Owner") + '</strong><span>Owner</span></div>' +
    '<div class="map-node work">Work<strong>' + escapeHtml(item.run.title) + '</strong><span>' + escapeHtml(titleCase(item.run.status)) + '</span></div>' +
    '<div class="map-node agent">🤖<strong>' + escapeHtml(item.agentRun?.agentName || "Agent") + '</strong><span>' + escapeHtml(item.agentRun?.role || "Agent") + '</span></div>' +
    '<div class="map-node tool">◉<strong>' + escapeHtml(connector?.name || "Policy Engine") + '</strong><span>' + escapeHtml(connector?.type || "Service") + "</span></div>" +
    "</section>"
  );
}

function renderRunTimeline(run) {
  return '<div class="timeline detail-timeline">' + (run.auditEvents || []).map((event) => renderTimelineItem({ type: event.action, text: event.summary, ago: relativeTime(event.occurredAt), occurredAt: event.occurredAt })).join("") + "</div>";
}

function renderTimelineItem(event) {
  return '<div class="timeline-item"><span>' + escapeHtml((event.type || "?").split(".")[0][0].toUpperCase()) + '</span><div><strong>' + escapeHtml(event.type) + '</strong><p>' + escapeHtml(event.text || "") + '</p></div><small>' + escapeHtml(event.ago || formatClock(event.occurredAt)) + "</small></div>";
}

function renderToolsTab(run) {
  const proposals = run.toolActionProposals || [];
  if (!proposals.length) return '<p class="empty-copy">No tool proposals yet.</p>';
  return proposals
    .map((proposal) => {
      const actionKey = "execute:" + proposal.id;
      const result = proposal.executionResult
        ? '<p class="execution-result">Purchase request: <strong>' + escapeHtml(proposal.executionResult.purchaseRequestRef || "—") + '</strong> · Ticket: <strong>' + escapeHtml(proposal.executionResult.ticketRef || "—") + "</strong></p>"
        : "";
      const executeButton = proposal.status === "approved" && canExecuteTools()
        ? '<button class="primary-button"' + actionAttrs("execute-tool", actionKey, 'data-tool-action-id="' + escapeHtml(proposal.id) + '"') + ">" + (state.loadingAction === actionKey ? "Executing..." : "Execute") + "</button>"
        : "";
      const helper = proposal.status === "approved" && !canExecuteTools() ? '<small class="muted">Switch to Omar Operator or Asha Admin to execute this action.</small>' : "";
      return '<div class="detail-row"><div><strong>' + escapeHtml(titleCase(proposal.actionType)) + '</strong><p>' + escapeHtml(proposal.summary) + '</p>' + result + helper + '</div><div class="detail-actions">' + statusBadge(proposal.status) + executeButton + "</div></div>";
    })
    .join("");
}

function renderApprovalsTab(run) {
  const approvals = run.approvalRequests || [];
  if (!approvals.length) return '<p class="empty-copy">No approval requests for this run.</p>';
  return approvals
    .map((approval) => {
      const pending = approval.status === "pending";
      const actionKey = "approval:" + approval.id;
      return (
        '<div class="detail-row" data-approval-id="' + escapeHtml(approval.id) + '"><div><strong>' + escapeHtml(titleCase(approval.status)) + ' approval</strong><p>' + escapeHtml(approval.requiredApprovers?.map((approver) => approver.reason).join(", ") || "Required approval") + '</p><small>Due ' + escapeHtml(dueIn(approval.dueAt)) + "</small></div>" +
        (pending && canDecideApproval(approval) ? '<div class="approval-actions compact"><button class="approve-button"' + actionAttrs("approve", actionKey + ":approve", 'data-approval-id="' + escapeHtml(approval.id) + '"') + '>Approve</button><button class="reject-button"' + actionAttrs("reject", actionKey + ":reject", 'data-approval-id="' + escapeHtml(approval.id) + '"') + ">Reject</button></div>" : pending ? '<small class="muted">Required approver/admin only</small>' : statusBadge(approval.status)) +
        "</div>"
      );
    })
    .join("");
}

function renderArtifactsTab(run) {
  const artifacts = run.evidenceArtifacts || [];
  if (!artifacts.length) return '<p class="empty-copy">No artifacts created yet.</p>';
  return artifacts.map((artifact) => '<div class="detail-row"><div><strong>' + escapeHtml(artifact.title) + '</strong><p>' + escapeHtml(titleCase(artifact.kind)) + '</p></div><small>' + escapeHtml(relativeTime(artifact.updatedAt || artifact.createdAt)) + "</small></div>").join("");
}

function renderPolicyTab(run) {
  const checks = run.policyChecks || [];
  if (!checks.length) return '<p class="empty-copy">No policy checks yet.</p>';
  return checks.map((check) => '<div class="detail-row"><div><strong>' + escapeHtml(check.summary) + '</strong><p>' + escapeHtml(check.action) + '</p></div><strong class="' + escapeHtml(check.result) + '">' + escapeHtml(titleCase(check.result)) + "</strong></div>").join("");
}

function renderTraceTab(run) {
  const events = run.auditEvents || [];
  if (!events.length) return '<p class="empty-copy">No trace events yet.</p>';
  return events.map((event) => '<div class="trace-row"><span>' + event.sequence + '</span><div><strong>' + escapeHtml(event.action) + '</strong><p>' + escapeHtml(event.actorType + ":" + event.actorId + " · " + event.source) + '</p></div><code>' + escapeHtml(String(event.hash || "").slice(0, 10)) + "</code></div>").join("");
}

async function simulateAgentRun(agentRunId) {
  const run = dashboard().agentRuns.find((entry) => entry.id === agentRunId);
  if (!run) return;
  await api("/api/workflow-runs/" + run.workflowRunId + "/agent-runs/simulate", { method: "POST" });
  state.selectedWorkflowRunId = run.workflowRunId;
  await load();
}

async function decideApproval(approvalId, action) {
  const approval = enrichedRuns().flatMap((item) => item.run.approvalRequests || []).find((entry) => entry.id === approvalId);
  const actor = currentActor();
  const requiredUserIds = approval?.requiredApprovers?.map((approver) => approver.userId) || [];
  const isAdminOverride = actor?.roles.includes("admin") && !requiredUserIds.includes(actor.id);
  await api("/api/approval-requests/" + approvalId + "/" + action, {
    method: "POST",
    body: JSON.stringify({
      comment: (action === "approve" ? "Approved" : "Rejected") + " from Agent Runs page.",
      overrideReason: isAdminOverride ? "Admin override from Agent Runs page" : undefined
    })
  });
  await load();
}

async function executeToolAction(toolActionId) {
  const updatedRun = await api("/api/tool-actions/" + toolActionId + "/execute", { method: "POST" });
  state.selectedWorkflowRunId = updatedRun.id;
  state.selectedTab = "tools";
  await load();
}

async function togglePolicyRule(ruleId) {
  const rule = (state.bootstrap.policyRules || []).find((entry) => entry.id === ruleId);
  if (!rule) throw new Error("Policy rule not found");
  await api("/api/policy-rules/" + ruleId, {
    method: "PUT",
    body: JSON.stringify({ enabled: !rule.enabled })
  });
  await load();
}

async function exportSelectedAudit() {
  const item = selectedRunItem() || enrichedRuns()[0];
  if (!item) throw new Error("No workflow run selected for audit export");
  const auditPacket = await api("/api/workflow-runs/" + item.run.id + "/audit-export");
  downloadJson("audit-export-" + item.run.id + ".json", auditPacket);
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function focusIntakeForm() {
  location.hash = "#settings";
  state.currentRoute = "settings";
  render();
  requestAnimationFrame(() => document.querySelector("#requestForm input")?.focus());
}

function resetRunFilters() {
  state.filters = {
    search: "",
    status: "all",
    agent: "all",
    risk: "all",
    owner: "all",
    department: "all",
    duration: "any",
    humanAction: "all",
    sla: "all",
    sortKey: "lastUpdated",
    sortDirection: "desc"
  };
}

function resetArtifactFilters() {
  state.artifactFilters = {
    search: "",
    type: "all",
    classification: "all",
    owner: "all",
    access: "all",
    policyStatus: "all",
    department: "all",
    date: "any",
    needsReview: "all",
    sla: "all",
    sortKey: "updated",
    sortDirection: "desc"
  };
}

function renderAndRestoreInput(selector, start, end) {
  render();
  const input = document.querySelector(selector);
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(start ?? input.value.length, end ?? input.value.length);
  }
}

function upsertById(collection, items) {
  const target = Array.isArray(collection) ? collection : [];
  for (const item of items || []) {
    const idx = target.findIndex((entry) => entry.id === item.id);
    if (idx !== -1) {
      target[idx] = item;
    } else {
      target.unshift(item);
    }
  }
  return target;
}

function applyObservabilityChanges(payload) {
  const changes = payload.changes || {};
  const dashboardModel = payload.dashboard || {};
  let hasChanges = false;

  if (changes.workflowRuns?.length) {
    state.bootstrap.workflowRuns = upsertById(state.bootstrap.workflowRuns, changes.workflowRuns);
    state.bootstrap.workflowRuns.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    enrichedRunsCache = null;
    hasChanges = true;
  }

  if (changes.agentRuns?.length) {
    state.bootstrap.dashboard.agentRuns = upsertById(state.bootstrap.dashboard.agentRuns, changes.agentRuns);
    state.bootstrap.dashboard.agentRuns.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    hasChanges = true;
  }

  if (changes.workItems?.length) {
    state.bootstrap.dashboard.workItems = upsertById(state.bootstrap.dashboard.workItems, changes.workItems);
    hasChanges = true;
  }

  if (Array.isArray(changes.humanApprovals)) {
    state.bootstrap.dashboard.humanApprovals = changes.humanApprovals;
    hasChanges = true;
  }

  if (changes.approvalRequests?.length) {
    state.bootstrap.approvalRequests = upsertById(state.bootstrap.approvalRequests, changes.approvalRequests);
    hasChanges = true;
  }

  if (changes.toolActionProposals?.length) {
    state.bootstrap.toolActionProposals = upsertById(state.bootstrap.toolActionProposals, changes.toolActionProposals);
    hasChanges = true;
  }

  if (changes.policyChecks?.length) {
    state.bootstrap.dashboard.policyAudit.checks = upsertById(state.bootstrap.dashboard.policyAudit.checks, changes.policyChecks);
    state.bootstrap.dashboard.policyAudit.checks.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    state.bootstrap.dashboard.policyAudit.checks = state.bootstrap.dashboard.policyAudit.checks.slice(0, 10);
    hasChanges = true;
  }

  if (changes.timeline?.length) {
    state.bootstrap.dashboard.timeline = upsertById(state.bootstrap.dashboard.timeline, changes.timeline);
    state.bootstrap.dashboard.timeline.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    state.bootstrap.dashboard.timeline = state.bootstrap.dashboard.timeline.slice(0, 30);
    hasChanges = true;
  }

  if (changes.artifacts?.length) {
    state.bootstrap.dashboard.artifacts = upsertById(state.bootstrap.dashboard.artifacts, changes.artifacts);
    hasChanges = true;
  }

  if (changes.auditEvents?.length && (state.currentRoute === "audit" || state.auditEvents.length)) {
    state.auditEvents = upsertById(state.auditEvents, changes.auditEvents);
    state.auditEvents.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    hasChanges = true;
  }

  if (dashboardModel.metrics) {
    state.bootstrap.dashboard.metrics = dashboardModel.metrics;
    hasChanges = true;
  }

  if (dashboardModel.analytics) {
    state.bootstrap.dashboard.analytics = dashboardModel.analytics;
    hasChanges = true;
  }

  if (dashboardModel.policyAudit?.summary) {
    state.bootstrap.dashboard.policyAudit.summary = dashboardModel.policyAudit.summary;
    hasChanges = true;
  }

  if (dashboardModel.policyAudit?.checks) {
    state.bootstrap.dashboard.policyAudit.checks = dashboardModel.policyAudit.checks;
    hasChanges = true;
  }

  if (payload.health) {
    state.health = payload.health;
  }

  state.cursor = payload.cursor || state.cursor || new Date().toISOString();
  state.lastLoadedAt = state.cursor;
  return hasChanges;
}

async function pollUpdate() {
  if (!state.bootstrap || !state.cursor) {
    return load();
  }
  const since = state.cursor;
  try {
    const payload = await api(`/api/observability/changes?since=${encodeURIComponent(since)}`);
    state.pollErrorCount = 0;
    const hasChanges = applyObservabilityChanges(payload);
    updateSystemStatus();

    if (hasChanges) {
      ensureSelectedRun();
      ensureSelectedArtifact();
      render();
    }
    configurePolling();
  } catch (error) {
    console.error("Incremental poll failed:", error);
    state.pollErrorCount = (state.pollErrorCount || 0) + 1;
    updateSystemStatus();
    state.errorMessage = "Connection degraded: " + error.message;
    render();
  }
}

function configurePolling() {
  const hasActiveRuns = dashboard().agentRuns.some((run) => run.status !== "completed");
  if (hasActiveRuns && !state.pollTimer) {
    state.pollTimer = setInterval(pollUpdate, 1500);
  }
  if (!hasActiveRuns && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

el.actorSelect.addEventListener("change", async (event) => {
  state.actorId = event.target.value;
  state.auditEvents = [];
  state.auditVerification = null;
  await load();
});

window.addEventListener("hashchange", async () => {
  state.currentRoute = routeFromHash();
  if (state.currentRoute === "audit") {
    try {
      await ensureAuditEventsLoaded();
    } catch (error) {
      state.errorMessage = error.message || "Failed to load audit events";
    }
  }
  render();
});

el.app.addEventListener("change", (event) => {
  const artifactFilter = event.target.closest("[data-artifact-filter]");
  if (artifactFilter) {
    state.artifactFilters[artifactFilter.dataset.artifactFilter] = artifactFilter.value;
    ensureSelectedArtifact(filteredArtifacts());
    render();
    return;
  }

  const auditFilter = event.target.closest("[data-audit-filter]");
  if (auditFilter) {
    state.auditFilters[auditFilter.dataset.auditFilter] = auditFilter.value;
    render();
    return;
  }

  const filter = event.target.closest("[data-filter]");
  if (!filter) return;
  state.filters[filter.dataset.filter] = filter.value;
  render();
});

el.app.addEventListener("input", (event) => {
  const artifactSearch = event.target.closest("[data-artifact-search]");
  if (artifactSearch) {
    const start = artifactSearch.selectionStart;
    const end = artifactSearch.selectionEnd;
    state.artifactFilters.search = artifactSearch.value;
    ensureSelectedArtifact(filteredArtifacts());
    renderAndRestoreInput("[data-artifact-search]", start, end);
    return;
  }

  const auditSearch = event.target.closest("[data-audit-search]");
  if (auditSearch) {
    const start = auditSearch.selectionStart;
    const end = auditSearch.selectionEnd;
    state.auditFilters.search = auditSearch.value;
    renderAndRestoreInput("[data-audit-search]", start, end);
    return;
  }

  const runSearch = event.target.closest("[data-run-search]");
  if (runSearch) {
    const start = runSearch.selectionStart;
    const end = runSearch.selectionEnd;
    state.filters.search = runSearch.value;
    renderAndRestoreInput("[data-run-search]", start, end);
  }
});

el.app.addEventListener("click", async (event) => {
  const artifactTab = event.target.closest("[data-artifact-tab]");
  if (artifactTab) {
    state.selectedArtifactTab = artifactTab.dataset.artifactTab;
    render();
    return;
  }

  const tab = event.target.closest("[data-detail-tab]");
  if (tab) {
    state.selectedTab = tab.dataset.detailTab;
    render();
    return;
  }

  const artifactRow = event.target.closest("[data-artifact-id]");
  const actionButton = event.target.closest("[data-action]");
  if (artifactRow && (!actionButton || actionButton.dataset.action === "select-artifact")) {
    state.selectedArtifactId = artifactRow.dataset.artifactId;
    render();
    return;
  }

  const auditRow = event.target.closest("[data-audit-event-id]");
  if (auditRow && (!actionButton || actionButton.dataset.action === "select-audit")) {
    state.selectedAuditEventId = auditRow.dataset.auditEventId;
    render();
    return;
  }

  const row = event.target.closest("[data-workflow-run-id]");
  if (row && (!actionButton || actionButton.dataset.action === "select-run")) {
    state.selectedWorkflowRunId = row.dataset.workflowRunId;
    render();
    return;
  }

  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "refresh") {
    await runUiAction("refresh", "Dashboard refreshed.", load);
  } else if (action === "simulate") {
    const agentRun = actionButton.closest("[data-agent-run-id]");
    if (agentRun) await runUiAction("simulate:" + agentRun.dataset.agentRunId, "Agent run simulation advanced.", () => simulateAgentRun(agentRun.dataset.agentRunId));
  } else if (action === "approve" || action === "reject") {
    await runUiAction("approval:" + actionButton.dataset.approvalId + ":" + action, titleCase(action) + " decision recorded.", () => decideApproval(actionButton.dataset.approvalId, action));
  } else if (action === "execute-tool") {
    await runUiAction("execute:" + actionButton.dataset.toolActionId, "Tool action executed.", () => executeToolAction(actionButton.dataset.toolActionId));
  } else if (action === "toggle-policy-rule") {
    await runUiAction("policy:" + actionButton.dataset.policyRuleId, "Policy rule updated.", () => togglePolicyRule(actionButton.dataset.policyRuleId));
  } else if (action === "export-audit") {
    await runUiAction("export-audit", "Audit export downloaded.", exportSelectedAudit);
  } else if (action === "create-run") {
    focusIntakeForm();
  } else if (action === "view-artifact-audit") {
    state.selectedArtifactTab = "audit";
    render();
  } else if (action === "view-run-audit") {
    state.selectedTab = "trace";
    render();
  } else if (action === "clear-filters") {
    resetRunFilters();
    render();
  } else if (action === "clear-artifact-filters") {
    resetArtifactFilters();
    ensureSelectedArtifact(filteredArtifacts());
    render();
  } else if (action === "clear-audit-filters") {
    resetAuditFilters();
    render();
  } else if (action === "close-drawer") {
    state.selectedWorkflowRunId = null;
    render();
  } else if (action === "close-artifact-drawer") {
    state.selectedArtifactId = null;
    render();
  } else if (action === "close-audit-drawer") {
    state.selectedAuditEventId = null;
    render();
  } else if (action === "verify-hash-chains") {
    await runUiAction("verify-hash-chains", "Audit hash chain verification completed.", async () => {
      state.auditVerification = await api("/api/audit-events/verify");
    });
  }
});

el.app.addEventListener("submit", async (event) => {
  if (event.target.id !== "requestForm") return;
  event.preventDefault();
  const form = new FormData(event.target);
  const request = Object.fromEntries(form.entries());
  request.amount = Number(request.amount);
  request.currency = "USD";
  request.businessJustification = "Created from Agent Enterprise dashboard for " + request.department + ".";
  await runUiAction("create-run-submit", "Procurement work item created.", async () => {
    const run = await api("/api/workflow-runs", {
      method: "POST",
      body: JSON.stringify({
        source: "ui",
        title: "Procurement request for " + request.vendor,
        request
      })
    });
    state.selectedWorkflowRunId = run.id;
    await api("/api/workflow-runs/" + run.id + "/agent-runs/simulate", { method: "POST" });
    location.hash = "#agentRuns";
    state.currentRoute = "agentRuns";
    await load();
  });
});

load().catch((error) => {
  document.body.innerHTML = '<main class="empty-state"><pre>' + escapeHtml(error.stack) + "</pre></main>";
});
