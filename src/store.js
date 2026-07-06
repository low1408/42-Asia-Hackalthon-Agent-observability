import { ROLES, nowIso } from "./domain.js";

export function createSeedStore() {
  const workspaceId = "ws_acme";
  const now = nowIso();

  return {
    workspaces: [
      {
        id: workspaceId,
        name: "Acme Corp",
        deploymentModel: "cloud_saas",
        retentionDays: 365
      }
    ],
    users: [
      {
        id: "usr_requester",
        workspaceId,
        name: "Rina Requester",
        email: "rina@example.com",
        department: "Operations",
        roles: [ROLES.REQUESTER]
      },
      {
        id: "usr_jane",
        workspaceId,
        name: "Jane Smith",
        email: "jane@example.com",
        department: "Legal",
        roles: [ROLES.REQUESTER, ROLES.APPROVER]
      },
      {
        id: "usr_mark",
        workspaceId,
        name: "Mark Reynolds",
        email: "mark@example.com",
        department: "Finance",
        roles: [ROLES.REQUESTER, ROLES.APPROVER]
      },
      {
        id: "usr_alex",
        workspaceId,
        name: "Alex Lee",
        email: "alex@example.com",
        department: "Security",
        roles: [ROLES.REQUESTER, ROLES.APPROVER]
      },
      {
        id: "usr_sara",
        workspaceId,
        name: "Sara Patel",
        email: "sara@example.com",
        department: "Marketing",
        roles: [ROLES.REQUESTER, ROLES.APPROVER]
      },
      {
        id: "usr_daniel",
        workspaceId,
        name: "Daniel Wong",
        email: "daniel@example.com",
        department: "IT",
        roles: [ROLES.REQUESTER, ROLES.APPROVER]
      },
      {
        id: "usr_manager",
        workspaceId,
        name: "Maya Manager",
        email: "maya@example.com",
        department: "Operations",
        roles: [ROLES.APPROVER]
      },
      {
        id: "usr_finance",
        workspaceId,
        name: "Felix Finance",
        email: "felix@example.com",
        department: "Finance",
        roles: [ROLES.APPROVER]
      },
      {
        id: "usr_compliance",
        workspaceId,
        name: "Cam Compliance",
        email: "cam@example.com",
        department: "Compliance",
        roles: [ROLES.APPROVER, ROLES.AUDITOR]
      },
      {
        id: "usr_operator",
        workspaceId,
        name: "Omar Operator",
        email: "omar@example.com",
        department: "Operations",
        roles: [ROLES.OPERATOR, ROLES.AUDITOR]
      },
      {
        id: "usr_admin",
        workspaceId,
        name: "Asha Admin",
        email: "asha@example.com",
        department: "Platform",
        roles: [ROLES.ADMIN, ROLES.AUDITOR, ROLES.OPERATOR, ROLES.APPROVER]
      }
    ],
    agents: [
      {
        id: "agt_procurement_triage",
        workspaceId,
        name: "Procurement Triage Agent",
        role: "Procurement Analyst",
        status: "active",
        authToken: "demo-agent-token",
        allowedWorkflows: ["procurement_intake"],
        allowedActionTypes: ["create_purchase_request", "create_ticket", "vendor_risk_review"],
        scopes: ["workflow:read", "proposal:create"]
      },
      {
        id: "agt_contract_analyst",
        workspaceId,
        name: "Contract Analyst",
        role: "Contract Review",
        status: "active",
        authToken: "demo-contract-token",
        allowedWorkflows: ["contract_review"],
        allowedActionTypes: ["contract_summary", "vendor_contract_approval"],
        scopes: ["contract:read", "proposal:create", "artifact:create"]
      },
      {
        id: "agt_data_analyst",
        workspaceId,
        name: "Data Analyst",
        role: "Financial Variance Analysis",
        status: "active",
        authToken: "demo-data-token",
        allowedWorkflows: ["financial_analysis"],
        allowedActionTypes: ["variance_report", "budget_increase_request"],
        scopes: ["finance:read", "proposal:create", "artifact:create"]
      },
      {
        id: "agt_web_researcher",
        workspaceId,
        name: "Web Researcher",
        role: "Market Landscape Scan",
        status: "active",
        authToken: "demo-research-token",
        allowedWorkflows: ["market_research"],
        allowedActionTypes: ["market_scan", "external_report_share"],
        scopes: ["web:search", "proposal:create"]
      },
      {
        id: "agt_secops",
        workspaceId,
        name: "SecOps Agent",
        role: "Security Incident Triage",
        status: "active",
        authToken: "demo-secops-token",
        allowedWorkflows: ["security_triage"],
        allowedActionTypes: ["incident_report", "containment_plan"],
        scopes: ["security:read", "proposal:create", "artifact:create"]
      },
      {
        id: "agt_access_review",
        workspaceId,
        name: "Access Review Bot",
        role: "IT Access Review",
        status: "active",
        authToken: "demo-access-token",
        allowedWorkflows: ["access_review"],
        allowedActionTypes: ["iam_role_request", "access_review_results"],
        scopes: ["iam:read", "proposal:create", "artifact:create"]
      },
      {
        id: "agt_report_generator",
        workspaceId,
        name: "Report Generator",
        role: "Executive Reporting",
        status: "active",
        authToken: "demo-report-token",
        allowedWorkflows: ["executive_reporting"],
        allowedActionTypes: ["weekly_summary", "customer_report_share"],
        scopes: ["reports:read", "proposal:create", "artifact:create"]
      }
    ],
    toolConnectors: [
      {
        id: "tool_procurement_record",
        workspaceId,
        name: "Lightweight Purchase Request System",
        type: "procurement_system",
        status: "connected",
        governedActions: ["create_purchase_request"]
      },
      {
        id: "tool_ticketing",
        workspaceId,
        name: "Service Desk Mock",
        type: "ticketing",
        status: "connected",
        governedActions: ["create_ticket"]
      },
      {
        id: "tool_contract_db",
        workspaceId,
        name: "Contract DB",
        type: "contract_repository",
        status: "connected",
        governedActions: ["contract_summary"]
      },
      {
        id: "tool_docusign",
        workspaceId,
        name: "DocuSign",
        type: "signature",
        status: "connected",
        governedActions: ["vendor_contract_approval"]
      },
      {
        id: "tool_policy_engine",
        workspaceId,
        name: "Policy Engine",
        type: "policy_service",
        status: "connected",
        governedActions: ["policy_check"]
      },
      {
        id: "tool_slack",
        workspaceId,
        name: "Slack Intake Mock",
        type: "chat",
        status: "connected",
        governedActions: ["create_intake_message"]
      },
      {
        id: "tool_email",
        workspaceId,
        name: "Shared Mailbox Mock",
        type: "email",
        status: "connected",
        governedActions: ["create_intake_email"]
      }
    ],
    workflowDefinitions: [
      {
        id: "wf_procurement_intake_v1",
        workspaceId,
        name: "Procurement Intake",
        type: "procurement_intake",
        version: 1,
        status: "active",
        defaultAgentId: "agt_procurement_triage",
        steps: [
          { id: "intake", type: "human_task", label: "Capture request" },
          { id: "agent_triage", type: "agent_task", label: "Classify and propose action" },
          { id: "policy_check", type: "policy_check", label: "Evaluate procurement policy" },
          { id: "approval_gate", type: "approval_gate", label: "Collect required approvals" },
          { id: "tool_action", type: "tool_action", label: "Create governed procurement record" },
          { id: "audit_checkpoint", type: "audit_checkpoint", label: "Finalize audit packet" }
        ]
      },
      {
        id: "wf_contract_review_v1",
        workspaceId,
        name: "Vendor Contract Review",
        type: "contract_review",
        version: 1,
        status: "active",
        defaultAgentId: "agt_contract_analyst",
        steps: [
          { id: "intake", type: "human_task", label: "Upload vendor contract" },
          { id: "agent_analysis", type: "agent_task", label: "Summarize risk and obligations" },
          { id: "approval_gate", type: "approval_gate", label: "Approve vendor contract" },
          { id: "artifact", type: "audit_checkpoint", label: "Publish summary draft" }
        ]
      },
      {
        id: "wf_financial_analysis_v1",
        workspaceId,
        name: "Financial Variance Analysis",
        type: "financial_analysis",
        version: 1,
        status: "active",
        defaultAgentId: "agt_data_analyst",
        steps: [
          { id: "intake", type: "human_task", label: "Upload finance packet" },
          { id: "agent_analysis", type: "agent_task", label: "Analyze variance" },
          { id: "approval_gate", type: "approval_gate", label: "Approve budget request" }
        ]
      },
      {
        id: "wf_market_research_v1",
        workspaceId,
        name: "Market Research",
        type: "market_research",
        version: 1,
        status: "active",
        defaultAgentId: "agt_web_researcher",
        steps: [
          { id: "intake", type: "human_task", label: "Capture research brief" },
          { id: "agent_research", type: "agent_task", label: "Scan market landscape" },
          { id: "tool_wait", type: "tool_action", label: "Use external research tool" }
        ]
      },
      {
        id: "wf_security_triage_v1",
        workspaceId,
        name: "Security Incident Triage",
        type: "security_triage",
        version: 1,
        status: "active",
        defaultAgentId: "agt_secops",
        steps: [
          { id: "detect", type: "tool_action", label: "Ingest alert" },
          { id: "agent_triage", type: "agent_task", label: "Classify incident" },
          { id: "approval_gate", type: "approval_gate", label: "Approve containment" }
        ]
      },
      {
        id: "wf_access_review_v1",
        workspaceId,
        name: "IT Access Review",
        type: "access_review",
        version: 1,
        status: "active",
        defaultAgentId: "agt_access_review",
        steps: [
          { id: "intake", type: "human_task", label: "Collect access scope" },
          { id: "agent_review", type: "agent_task", label: "Review privileged access" },
          { id: "approval_gate", type: "approval_gate", label: "Approve IAM role" }
        ]
      },
      {
        id: "wf_executive_reporting_v1",
        workspaceId,
        name: "Executive Reporting",
        type: "executive_reporting",
        version: 1,
        status: "active",
        defaultAgentId: "agt_report_generator",
        steps: [
          { id: "intake", type: "human_task", label: "Define report audience" },
          { id: "agent_report", type: "agent_task", label: "Generate executive summary" },
          { id: "artifact", type: "audit_checkpoint", label: "Publish presentation" }
        ]
      }
    ],
    policyRules: [
      {
        id: "pol_amount_manager",
        workspaceId,
        name: "Manager approval for spend above 1,000",
        type: "approval",
        enabled: true,
        condition: { field: "amount", operator: "gt", value: 1000 },
        approverRole: "manager",
        approverUserId: "usr_manager"
      },
      {
        id: "pol_amount_finance",
        workspaceId,
        name: "Finance approval for spend above 10,000",
        type: "approval",
        enabled: true,
        condition: { field: "amount", operator: "gt", value: 10000 },
        approverRole: "finance",
        approverUserId: "usr_finance"
      },
      {
        id: "pol_vendor_risk",
        workspaceId,
        name: "Compliance review for high-risk vendors",
        type: "approval",
        enabled: true,
        condition: { field: "vendorRisk", operator: "eq", value: "high" },
        approverRole: "compliance",
        approverUserId: "usr_compliance"
      },
      {
        id: "pol_block_sanctioned",
        workspaceId,
        name: "Block sanctioned vendors",
        type: "block",
        enabled: true,
        condition: { field: "vendorRisk", operator: "eq", value: "sanctioned" },
        reason: "Vendor risk is sanctioned; manual override requires admin."
      }
    ],
    workflowRuns: [],
    tasks: [],
    approvalRequests: [],
    toolActionProposals: [],
    agentRuns: [],
    policyChecks: [],
    auditEvents: [],
    evidenceArtifacts: [],
    purchaseRequests: [],
    tickets: [],
    createdAt: now
  };
}
