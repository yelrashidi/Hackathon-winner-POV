// Feature 6 — approvals. Other features import from here, never from the files directly
// (docs/rules/backend.md: "feature code calls other features through their exported service").
export { planApprovals, type PlanHistory } from "./route";
export {
  reapprovalReasons,
  approvalAging,
  businessDaysBetween,
  REAPPROVAL_TOLERANCE,
  type Aging,
  type AgingOptions,
} from "./lifecycle";
export {
  checkDecision,
  applyDecision,
  approversOf,
  currentStep,
  isAwaiting,
  waitingOn,
  PENDING_APPROVAL_STATUS,
  type DecisionAction,
  type DecisionCheck,
  type DecisionContext,
  type DecisionDeniedCode,
  type DecisionRequest,
  type DecisionResult,
  type InvoiceRef,
} from "./decide";
export { effectiveAssignee, type Resolution } from "./resolve";
export { policiesFromCsv, DEFAULT_NEW_VENDOR_DAYS, type PolicyCsvRow } from "./policies-from-csv";
export type {
  ApprovalContext,
  DirectoryDepartment,
  DirectoryUser,
  DirectoryVendor,
  UserRole,
  UserStatus,
} from "./directory";
