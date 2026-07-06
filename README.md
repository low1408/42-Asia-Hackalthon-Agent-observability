# Enterprise Agent-Human Collaboration Layer

MVP implementation of a cloud SaaS operating surface where humans, bring-your-own agents, and enterprise tools collaborate on governed procurement workflows.

The app intentionally uses zero runtime dependencies so it can run in restricted environments:

- Node HTTP API
- In-memory seed store
- Vanilla browser UI
- Node built-in test runner

## Run

```bash
npm start
```

Open http://localhost:3010.

## Test

```bash
npm test
```

## Demo actors

The UI includes an actor picker:

- Rina Requester: creates procurement requests.
- Procurement Triage Agent: submits proposals through the agent API.
- Maya Manager, Felix Finance, Cam Compliance: approve policy-routed requests.
- Omar Operator: executes approved governed tool actions.
- Asha Admin: updates policy rules and can perform admin override flows.

## Implemented MVP surface

- Agent Enterprise-style dashboard with sidebar navigation, metric cards, live workboard, multi-role agent runs, human approvals, delegation map, shared timeline, policy checks, and artifacts.
- Dashboard panels backed by computed domain read models instead of static dashboard collections.
- Real work-item, agent-run, approval, timeline, policy-check, artifact, and delegation-map services.
- Explicit agent-run lifecycle APIs with simulation, progress, completion, and audit events.
- Procurement request intake from UI and webhook API.
- External agent proposal API.
- Policy evaluation for amount thresholds, vendor risk, and sanctioned vendor blocking.
- Approval routing with multiple required approvers.
- Mediated tool execution into mock purchase-request and ticketing systems.
- Append-only audit events with hash-chain validation.
- Audit trail and JSON audit export.
- Basic RBAC for requester, approver, operator, auditor, and admin roles.
- Admin policy enable/disable controls.

## Service-backed dashboard APIs

- GET /api/bootstrap
- GET /api/work-items
- GET /api/work-items/:id
- GET /api/agent-runs
- GET /api/agent-runs/:id
- POST /api/workflow-runs/:id/agent-runs/simulate
- POST /api/agent-runs/:id/progress
- POST /api/agent-runs/:id/complete
- GET /api/approval-requests
- GET /api/timeline
- GET /api/policy-checks
- GET /api/audit-events
- GET /api/artifacts
- GET /api/workflow-runs/:id/delegation-map

## API examples

Create a workflow run:

```bash
curl -X POST http://localhost:3010/api/workflow-runs \
  -H 'content-type: application/json' \
  -H 'x-user-id: usr_requester' \
  -d '{"source":"api","request":{"vendor":"Atlas Cloud","amount":12500,"department":"Operations","category":"software","vendorRisk":"high","businessJustification":"Q3 expansion"}}'
```

Submit an external agent proposal:

```bash
curl -X POST http://localhost:3010/api/agents/agt_procurement_triage/proposals \
  -H 'content-type: application/json' \
  -H 'x-agent-token: demo-agent-token' \
  -d '{"workflowRunId":"RUN_ID","proposal":{"actionType":"create_purchase_request","summary":"Create governed purchase request after approval.","confidence":0.9}}'
```

Export an audit packet:

```bash
curl http://localhost:3010/api/workflow-runs/RUN_ID/audit-export \
  -H 'x-user-id: usr_operator'
```

## Notes for production hardening

This MVP keeps data in memory. Production work should replace the store with a transactional database, add real SSO/OIDC, configure managed secret storage, persist connector credentials, enforce tenant isolation at query boundaries, and move audit events to immutable storage.
