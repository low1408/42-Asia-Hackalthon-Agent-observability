const state = {
  bootstrap: null,
  actorId: "usr_admin",
  pollTimer: null,
  currentRoute: routeFromHash(),
  selectedWorkflowRunId: null,
  selectedTab: "overview",
  filters: {
    status: "all",
    agent: "all",
    risk: "all",
    owner: "all",
    department: "all",
    duration: "any",
    humanAction: "all",
    sla: "all"
  }
};

const el = {
  app: document.querySelector("#app"),
  actorSelect: document.querySelector("#actorSelect"),
  avatar: document.querySelector(".avatar")
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
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function load() {
  state.bootstrap = await api("/api/bootstrap");
  ensureSelectedRun();
  render();
  configurePolling();
}

function routeFromHash() {
  return (location.hash || "#").replace("#", "") || "home";
}

function pageForRoute(route) {
  return route === "agentRuns" ? "agentRuns" : "home";
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

function enrichedRuns() {
  return (state.bootstrap.workflowRuns || []).map((run) => {
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
      department: run.request?.department || owner?.department || "Unknown"
    };
  });
}

function filteredRuns() {
  return enrichedRuns().filter((item) => {
    if (state.filters.status !== "all" && item.status !== state.filters.status && item.run.status !== state.filters.status) return false;
    if (state.filters.agent !== "all" && item.agentRun?.agentId !== state.filters.agent) return false;
    if (state.filters.risk !== "all" && item.risk !== state.filters.risk) return false;
    if (state.filters.owner !== "all" && item.owner?.id !== state.filters.owner) return false;
    if (state.filters.department !== "all" && item.department !== state.filters.department) return false;
    if (state.filters.humanAction === "yes" && item.approvals.length === 0) return false;
    if (state.filters.humanAction === "no" && item.approvals.length > 0) return false;
    if (state.filters.sla === "breached" && !item.approvals.some((approval) => new Date(approval.dueAt).getTime() < Date.now())) return false;
    if (state.filters.sla === "healthy" && item.approvals.some((approval) => new Date(approval.dueAt).getTime() < Date.now())) return false;
    if (state.filters.duration === "under10" && durationMinutes(item) >= 10) return false;
    if (state.filters.duration === "over10" && durationMinutes(item) <= 10) return false;
    return true;
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

function render() {
  renderActorPicker();
  renderNavigation();
  if (pageForRoute(state.currentRoute) === "agentRuns") {
    renderAgentRunsPage();
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

function renderHomePage() {
  const focus = state.currentRoute;
  const policyFocused = focus === "policyAudit" || focus === "audit" || focus === "analytics";
  el.app.className = "dashboard";
  el.app.innerHTML =
    '<section class="utility-row">' +
    "<div></div>" +
    '<label class="date-filter">📅<select><option>Last 24 hours</option><option>Last 7 days</option><option>Last 30 days</option></select></label>' +
    '<button class="icon-button" data-action="refresh">↻</button>' +
    "</section>" +
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
  return (
    '<div class="agent-run" data-agent-run-id="' + escapeHtml(run.id) + '">' +
    '<div class="run-avatar">' + escapeHtml(run.agentName.slice(0, 2).toUpperCase()) + "</div>" +
    '<div class="agent-run-main"><div class="agent-run-heading"><strong>' + escapeHtml(run.agentName) + "</strong>" + statusBadge(run.status) + "</div>" +
    "<p>" + escapeHtml(run.role) + "</p>" +
    '<div class="progress-row"><div class="progress"><span style="width: ' + Number(run.progress) + '%"></span></div><small>' + Number(run.progress) + "%</small></div>" +
    (run.waitingOn ? '<small class="muted">Waiting on: ' + escapeHtml(run.waitingOn) + "</small>" : "") +
    "</div>" +
    '<button class="simulate-button" data-action="simulate" ' + (run.status === "completed" ? "disabled" : "") + ">Sim</button>" +
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
    '<div class="tabs"><button class="active">Policy Checks</button><button>Audit Log</button></div>' +
    '<div class="policy-summary"><div><span>All Checks</span><strong>' + summary.allChecks + "</strong></div><div><span>Allowed</span><strong>" + summary.allowed + "</strong></div><div><span>Blocked</span><strong>" + summary.blocked + "</strong></div><div><span>Alerts</span><strong>" + summary.alerts + "</strong></div></div>" +
    '<div class="policy-checks">' +
    dashboard()
      .policyAudit.checks.map((check) => '<div class="policy-row"><span>▧ ' + escapeHtml(check.summary) + '</span><strong class="' + escapeHtml(check.result) + '">' + escapeHtml(titleCase(check.result)) + "</strong><small>" + escapeHtml(check.ago || "") + "</small></div>")
      .join("") +
    '</div><a class="panel-footer-link" href="#policyAudit">View all policy checks</a></article>'
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
    '<div class="page-actions"><button class="primary-button">＋ Create Run</button><button data-action="refresh">⇩ Export</button><button>··· More</button></div>' +
    "</section>" +
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
    '<div class="search run-search">⌕ <span>Search runs, work items, agents, owners...</span></div>' +
    '<label>Status<select data-filter="status">' + selectOptions(statuses, state.filters.status, "All") + "</select></label>" +
    '<label>Agent<select data-filter="agent">' + selectOptions(agents, state.filters.agent, "All") + "</select></label>" +
    '<label>Risk<select data-filter="risk">' + selectOptions(risks, state.filters.risk, "All") + "</select></label>" +
    '<label>Owner<select data-filter="owner">' + selectOptions(owners, state.filters.owner, "All") + "</select></label>" +
    '<label>Department<select data-filter="department">' + selectOptions(departments, state.filters.department, "All") + "</select></label>" +
    '<label>Duration<select data-filter="duration"><option value="any">Any</option><option value="under10"' + (state.filters.duration === "under10" ? " selected" : "") + '>Under 10m</option><option value="over10"' + (state.filters.duration === "over10" ? " selected" : "") + ">Over 10m</option></select></label>" +
    '<label>Needs Human Action<select data-filter="humanAction"><option value="all">All</option><option value="yes"' + (state.filters.humanAction === "yes" ? " selected" : "") + '>Yes</option><option value="no"' + (state.filters.humanAction === "no" ? " selected" : "") + ">No</option></select></label>" +
    '<label>SLA Breached<select data-filter="sla"><option value="all">All</option><option value="breached"' + (state.filters.sla === "breached" ? " selected" : "") + '>Breached</option><option value="healthy"' + (state.filters.sla === "healthy" ? " selected" : "") + ">Healthy</option></select></label>" +
    '<button data-action="clear-filters">Filters</button><button>Sort: Last updated⌃</button>' +
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
  return (
    '<aside class="run-detail-drawer panel">' +
    '<div class="drawer-heading"><div><span class="live-dot">●</span><h2>' + escapeHtml(run.title) + '</h2><div class="drawer-badges">' + statusBadge(item.status) + riskBadge(item.risk) + '</div></div><button data-action="close-drawer">×</button></div>' +
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
  return (
    '<section class="current-request">' +
    "<h3>ⓘ Current Request</h3>" +
    "<p>Approve " + escapeHtml(item.run.title.toLowerCase()) + " for governed execution.</p>" +
    "<small>Reason</small><strong>" + escapeHtml(approval.policyResult?.summary || approval.requiredApprovers?.[0]?.reason || "Policy requires human approval.") + "</strong>" +
    '<div class="approval-actions"><button class="approve-button" data-action="approve" data-approval-id="' + escapeHtml(approval.id) + '">✓ Approve</button><button class="reject-button" data-action="reject" data-approval-id="' + escapeHtml(approval.id) + '">⊗ Reject</button><button>✎ Request Changes</button><button>↗ Escalate</button></div>' +
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
  return proposals.map((proposal) => '<div class="detail-row"><div><strong>' + escapeHtml(titleCase(proposal.actionType)) + '</strong><p>' + escapeHtml(proposal.summary) + '</p></div>' + statusBadge(proposal.status) + '</div>').join("");
}

function renderApprovalsTab(run) {
  const approvals = run.approvalRequests || [];
  if (!approvals.length) return '<p class="empty-copy">No approval requests for this run.</p>';
  return approvals
    .map((approval) => {
      const pending = approval.status === "pending";
      return (
        '<div class="detail-row" data-approval-id="' + escapeHtml(approval.id) + '"><div><strong>' + escapeHtml(titleCase(approval.status)) + ' approval</strong><p>' + escapeHtml(approval.requiredApprovers?.map((approver) => approver.reason).join(", ") || "Required approval") + '</p><small>Due ' + escapeHtml(dueIn(approval.dueAt)) + "</small></div>" +
        (pending ? '<div class="approval-actions compact"><button class="approve-button" data-action="approve" data-approval-id="' + escapeHtml(approval.id) + '">Approve</button><button class="reject-button" data-action="reject" data-approval-id="' + escapeHtml(approval.id) + '">Reject</button></div>' : statusBadge(approval.status)) +
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

function configurePolling() {
  const hasActiveRuns = dashboard().agentRuns.some((run) => run.status !== "completed");
  if (hasActiveRuns && !state.pollTimer) {
    state.pollTimer = setInterval(load, 1500);
  }
  if (!hasActiveRuns && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

el.actorSelect.addEventListener("change", async (event) => {
  state.actorId = event.target.value;
  await load();
});

window.addEventListener("hashchange", () => {
  state.currentRoute = routeFromHash();
  render();
});

el.app.addEventListener("change", (event) => {
  const filter = event.target.closest("[data-filter]");
  if (!filter) return;
  state.filters[filter.dataset.filter] = filter.value;
  render();
});

el.app.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-detail-tab]");
  if (tab) {
    state.selectedTab = tab.dataset.detailTab;
    render();
    return;
  }

  const row = event.target.closest("[data-workflow-run-id]");
  const actionButton = event.target.closest("[data-action]");
  if (row && (!actionButton || actionButton.dataset.action === "select-run")) {
    state.selectedWorkflowRunId = row.dataset.workflowRunId;
    render();
    return;
  }

  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "refresh") {
    await load();
  } else if (action === "simulate") {
    const agentRun = actionButton.closest("[data-agent-run-id]");
    if (agentRun) await simulateAgentRun(agentRun.dataset.agentRunId);
  } else if (action === "approve" || action === "reject") {
    await decideApproval(actionButton.dataset.approvalId, action);
  } else if (action === "clear-filters") {
    state.filters = { status: "all", agent: "all", risk: "all", owner: "all", department: "all", duration: "any", humanAction: "all", sla: "all" };
    render();
  } else if (action === "close-drawer") {
    state.selectedWorkflowRunId = null;
    render();
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

load().catch((error) => {
  document.body.innerHTML = '<main class="empty-state"><pre>' + escapeHtml(error.stack) + "</pre></main>";
});
