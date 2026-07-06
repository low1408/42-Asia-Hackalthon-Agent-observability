const state = {
  bootstrap: null,
  actorId: "usr_admin",
  pollTimer: null
};

const el = {
  actorSelect: document.querySelector("#actorSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  metricGrid: document.querySelector("#metricGrid"),
  workItemCount: document.querySelector("#workItemCount"),
  workboardTable: document.querySelector("#workboardTable"),
  agentRunCount: document.querySelector("#agentRunCount"),
  agentRunList: document.querySelector("#agentRunList"),
  approvalCount: document.querySelector("#approvalCount"),
  humanApprovals: document.querySelector("#humanApprovals"),
  sharedTimeline: document.querySelector("#sharedTimeline"),
  policyChecks: document.querySelector("#policyChecks"),
  artifactsTable: document.querySelector("#artifactsTable"),
  requestForm: document.querySelector("#requestForm"),
  delegationMap: document.querySelector("#delegationMap")
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
  render();
  configurePolling();
}

function titleCase(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function riskBadge(risk) {
  return '<span class="badge risk-' + risk + '">' + titleCase(risk) + "</span>";
}

function statusBadge(status) {
  return '<span class="badge status-' + status + '">' + titleCase(status) + "</span>";
}

function currentActor() {
  return state.bootstrap?.users.find((user) => user.id === state.actorId);
}

function dashboard() {
  return state.bootstrap.dashboard;
}

function renderActorPicker() {
  el.actorSelect.innerHTML = state.bootstrap.users
    .map((user) => {
      const selected = user.id === state.actorId ? " selected" : "";
      return '<option value="' + user.id + '"' + selected + ">" + user.name.split(" ")[0] + "</option>";
    })
    .join("");
}

function renderMetrics() {
  el.metricGrid.innerHTML = dashboard()
    .metrics.map((metric) => {
      const deltaClass = metric.delta.startsWith("↓") ? "negative" : "positive";
      return (
        '<article class="metric-card">' +
        '<div class="metric-icon ' + metric.tone + '">' + metric.icon + "</div>" +
        '<div><span>' + metric.label + '</span><strong>' + metric.value + '</strong><small class="' + deltaClass + '">' + metric.delta + "</small></div>" +
        '<svg viewBox="0 0 120 34" aria-hidden="true"><polyline points="2,27 18,21 32,24 47,14 64,23 80,10 98,18 118,16" /></svg>' +
        "</article>"
      );
    })
    .join("");
}

function renderWorkboard() {
  const rows = dashboard().workItems.slice(0, 7);
  el.workItemCount.textContent = String(dashboard().workItems.length);
  el.workboardTable.innerHTML =
    "<table><thead><tr><th>Title</th><th>Owner</th><th>Assigned Agent</th><th>Status</th><th>Risk</th><th>Last Updated</th></tr></thead><tbody>" +
    rows
      .map((row) => {
        return (
          "<tr>" +
          '<td><span class="doc-icon">▧</span>' + row.title + "</td>" +
          '<td><span class="owner-chip">' + row.ownerInitials + "</span>" + row.owner + "</td>" +
          "<td>🤖 " + row.assignedAgent + "</td>" +
          "<td>" + statusBadge(row.status) + "</td>" +
          "<td>" + riskBadge(row.risk) + "</td>" +
          "<td>" + row.lastUpdated + "</td>" +
          "</tr>"
        );
      })
      .join("") +
    '</tbody></table><div class="table-footer">Showing 1–' + rows.length + " of " + dashboard().workItems.length + " <span>‹ 1 ›</span></div>";
}

function renderAgentRuns() {
  const runs = dashboard().agentRuns;
  const active = runs.filter((run) => run.status !== "completed").length;
  el.agentRunCount.textContent = active + " active";
  el.agentRunList.innerHTML = runs
    .slice(0, 7)
    .map((run) => {
      return (
        '<div class="agent-run" data-agent-run-id="' + run.id + '">' +
        '<div class="run-avatar">' + run.agentName.slice(0, 2).toUpperCase() + "</div>" +
        '<div class="agent-run-main">' +
        '<div class="agent-run-heading"><strong>' + run.agentName + "</strong>" + statusBadge(run.status) + "</div>" +
        "<p>" + run.role + "</p>" +
        '<div class="progress-row"><div class="progress"><span style="width: ' + run.progress + '%"></span></div><small>' + run.progress + "%</small></div>" +
        (run.waitingOn ? '<small class="muted">Waiting on: ' + run.waitingOn + "</small>" : "") +
        "</div>" +
        '<button class="simulate-button" data-action="simulate" ' + (run.status === "completed" ? "disabled" : "") + ">Sim</button>" +
        "</div>"
      );
    })
    .join("");
}

function renderApprovals() {
  const approvals = dashboard().humanApprovals;
  el.approvalCount.textContent = String(approvals.length);
  el.humanApprovals.innerHTML = approvals
    .map((approval) => {
      return (
        '<div class="approval-item" data-approval-id="' + approval.id + '">' +
        "<div><strong>" + approval.title + "</strong><p>" + approval.agentName + "</p></div>" +
        riskBadge(approval.risk) +
        "<small>Due in<br />" + approval.dueIn + "</small>" +
        '<button class="approve-button" data-action="approve">✓ Approve</button>' +
        '<button class="reject-button" data-action="reject">Reject</button>' +
        "</div>"
      );
    })
    .join("");
}

function renderTimeline() {
  el.sharedTimeline.innerHTML = dashboard()
    .timeline.slice(0, 8)
    .map((event) => {
      return (
        '<div class="timeline-item">' +
        "<span>" + event.type.split(".")[0][0].toUpperCase() + "</span>" +
        "<div><strong>" + event.type + "</strong><p>" + event.text + "</p></div>" +
        "<small>" + event.ago + "</small>" +
        "</div>"
      );
    })
    .join("");
}

function renderPolicyChecks() {
  const summary = dashboard().policyAudit.summary;
  document.querySelector(".policy-summary").innerHTML =
    "<div><span>All Checks</span><strong>" +
    summary.allChecks +
    "</strong></div><div><span>Allowed</span><strong>" +
    summary.allowed +
    "</strong></div><div><span>Blocked</span><strong>" +
    summary.blocked +
    "</strong></div><div><span>Alerts</span><strong>" +
    summary.alerts +
    "</strong></div>";
  el.policyChecks.innerHTML = dashboard()
    .policyAudit.checks.map((check) => {
      return '<div class="policy-row"><span>▧ ' + check.summary + '</span><strong class="' + check.result + '">' + titleCase(check.result) + "</strong><small>" + (check.ago || "") + "</small></div>";
    })
    .join("");
}

function renderArtifacts() {
  el.artifactsTable.innerHTML =
    "<table><thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Updated</th></tr></thead><tbody>" +
    dashboard()
      .artifacts.slice(0, 8)
      .map((artifact) => {
        return (
          "<tr>" +
          '<td><span class="doc-icon">▧</span>' + artifact.name + "</td>" +
          "<td>" + artifact.type + "</td>" +
          "<td>🤖 " + artifact.owner + "</td>" +
          "<td>" + artifact.updated + "</td>" +
          "</tr>"
        );
      })
      .join("") +
    "</tbody></table>";
}

function renderDelegationMap() {
  if (!el.delegationMap) return;
  const map = dashboard().delegationMap;
  const node = (type) => map.nodes.find((entry) => entry.type === type);
  const human = node("human") || {};
  const agent = node("agent") || {};
  const work = node("work") || {};
  const tool = node("tool") || {};
  const service = node("service") || {};
  el.delegationMap.innerHTML =
    '<div class="map-node human">👤<strong>' + (human.label || "Human") + "</strong><span>" + (human.subtitle || "Owner") + "</span></div>" +
    '<div class="map-node agent">🤖<strong>' + (agent.label || "Agent") + "</strong><span>" + (agent.subtitle || "Agent") + "</span></div>" +
    '<div class="map-node work">Work Item<strong>' + (work.label || "Work Item") + "</strong><span>" + (work.subtitle || "Status") + "</span></div>" +
    '<div class="map-column"><div class="map-node tool">◉<strong>' + (tool.label || "Tool") + "</strong><span>" + (tool.subtitle || "Tool") + '</span></div><div class="map-node tool">⬡<strong>' + (service.label || "Policy Engine") + "</strong><span>" + (service.subtitle || "Service") + "</span></div></div>";
}

function render() {
  renderActorPicker();
  renderMetrics();
  renderWorkboard();
  renderAgentRuns();
  renderApprovals();
  renderTimeline();
  renderPolicyChecks();
  renderArtifacts();
  renderDelegationMap();
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

el.actorSelect.addEventListener("change", (event) => {
  state.actorId = event.target.value;
});

el.refreshButton.addEventListener("click", load);

el.agentRunList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='simulate']");
  const item = event.target.closest("[data-agent-run-id]");
  if (!button || !item) return;
  const run = dashboard().agentRuns.find((entry) => entry.id === item.dataset.agentRunId);
  if (!run) return;
  await api("/api/workflow-runs/" + run.workflowRunId + "/agent-runs/simulate", { method: "POST" });
  await load();
});

el.humanApprovals.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const item = event.target.closest("[data-approval-id]");
  if (!button || !item) return;
  const approval = dashboard().humanApprovals.find((entry) => entry.id === item.dataset.approvalId);
  const actor = currentActor();
  const requiredUserIds = approval?.requiredApprovers.map((approver) => approver.userId) || [];
  const isAdminOverride = actor?.roles.includes("admin") && !requiredUserIds.includes(actor.id);
  if (button.dataset.action === "approve") {
    await api("/api/approval-requests/" + item.dataset.approvalId + "/approve", {
      method: "POST",
      body: JSON.stringify({
        comment: "Approved from Agent Enterprise dashboard.",
        overrideReason: isAdminOverride ? "Admin override from dashboard" : undefined
      })
    });
  } else {
    await api("/api/approval-requests/" + item.dataset.approvalId + "/reject", {
      method: "POST",
      body: JSON.stringify({
        comment: "Rejected from Agent Enterprise dashboard.",
        overrideReason: isAdminOverride ? "Admin override from dashboard" : undefined
      })
    });
  }
  await load();
});

el.requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
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
  await api("/api/workflow-runs/" + run.id + "/agent-runs/simulate", { method: "POST" });
  await load();
});

load().catch((error) => {
  document.body.innerHTML = '<main class="empty-state"><pre>' + error.stack + "</pre></main>";
});
