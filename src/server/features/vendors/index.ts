/**
 * Feature 9 — vendor management (server side). Route handlers and server actions call these.
 * Guide: docs/architecture/9-vendors.md. Screens' data shapes: src/contracts/vendor.ts.
 *
 *   read    listVendors, getVendorDetail                       vendor.view (clerk, FM, controller, auditor)
 *   write   onboardVendor, approveVendor, holdVendor, releaseVendorHold,
 *           requestBankChange, verifyBankChange, rejectBankChange
 *   form    vendorDraftFromInvoice                             onboarding prefilled from an invoice
 *   others  vendorConflicts                                    for approvals (who may not approve)
 */
export { listVendors, getVendorDetail } from "./read";
export {
  onboardVendor,
  approveVendor,
  holdVendor,
  releaseVendorHold,
  requestBankChange,
  verifyBankChange,
  rejectBankChange,
  vendorDraftFromInvoice,
  nextVendorId,
  type VendorOptions,
} from "./service";
export { vendorConflicts } from "./conflicts";
export { VendorError } from "./shared";
export * as vendorRules from "./rules";
