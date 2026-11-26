export type {
  ApprovalAction,
  ApprovalPolicy,
  ApprovalPolicyDecision,
  ApprovalPolicyRule,
  ApprovalPolicyVerdict,
  ApprovalRequest,
  ApprovalRequester,
  ApprovalServiceContract,
  ApprovalStatus,
} from "@generic-ai/sdk";
export {
  DEFAULT_APPROVAL_POLICY,
  evaluateApprovalPolicy,
  OUTWARD_EFFECTS,
  parseApprovalPolicy,
} from "@generic-ai/sdk";

export * from "./gate.js";
export * from "./routes.js";
export * from "./service.js";
export * from "./topology.js";

export const name = "@generic-ai/plugin-approvals" as const;
export const kind = "approvals" as const;
