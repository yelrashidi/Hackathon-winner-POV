"""
Step 6 - Approval routing and server-side approval enforcement (DRAFT).

Input:  one invoice that has already been through steps 1-5 (intake, extraction,
        coding, validation, duplicate check), plus the flags those steps raised.
Output: an approval Workflow (ordered list of steps, each assigned to one person,
        each with the reasons/rule ids that put it there) and an audit trail.

Design:
  * Rules come from data/approval_policies.csv where they're data-driven (the
    amount tiers P01-P04 are parsed from the CSV, so the Controller can change
    thresholds without a code change). The other rules (P05-P08, P12-P13) are
    implemented in code but always cite their rule_id so flags can explain
    themselves in the UI.
  * Every permission check lives in ApprovalService.act(), the single entry
    point an API handler should call. Hiding the button in the UI isn't
    enough; this function raises if Maria tries to approve her own bill.
  * One person never signs two steps on the same invoice, and never their
    own request (P07). Conflicts escalate to the approver's manager.
  * Delegation (P08) is resolved at routing time AND re-checked at action
    time, and the record keeps both who it was routed to and who acted.
  * Storage is in-memory dicts for now; swap self.workflows / self.audit_log
    for your DB tables.

Run the self-test / replay against the dataset:
    python3 step6_approval.py --data ~/Downloads/brim_ap_dataset/data
"""

from __future__ import annotations

import argparse
import csv
import re
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional

AS_OF = date(2026, 11, 2)          # dataset as-of date (README)
NEW_VENDOR_DAYS = 90               # "brand-new vendor" window for P05
SPLIT_WINDOW_DAYS = 3              # split-invoice look-back window

# ---------------------------------------------------------------------------
# What steps 4/5 hand us. Align these codes with whatever your validation and
# duplicate modules emit. The effect decides how approval treats the flag:
#   "hold"            -> no routing; the invoice parks in on_hold for AP to fix
#   "finance_review"  -> adds a finance_manager step (like P05/P06/P12)
#   "info"            -> routed normally, flag shown to every approver
# Unknown codes default to "info" (with severity "block" -> "hold").
# ---------------------------------------------------------------------------
FLAG_EFFECTS = {
    "DUPLICATE_SUSPECTED": "hold",
    "ALREADY_PAID_BY_CARD": "hold",
    "VENDOR_UNKNOWN": "finance_review",
    "VENDOR_ON_HOLD": "hold",
    "LOOKALIKE_SENDER": "hold",
    "PO_MISSING": "hold",               # P13
    "PO_OVER_BALANCE": "finance_review",  # P12
    "PRICE_OVER_CONTRACT": "finance_review",
    "BANK_CHANGE_UNVERIFIED": "finance_review",  # step 7 must also block release
    "TAX_MISMATCH": "info",
    "MATH_MISMATCH": "info",
    "SPLIT_INVOICE_SUSPECTED": "info",  # also bumps the amount tier, see below
}


# ============================== data model =================================

@dataclass
class ValidationFlag:
    code: str
    message: str                       # human-readable: "Price $250 exceeds contract cap $230"
    severity: str = "warning"          # info | warning | block
    rule_id: Optional[str] = None


@dataclass
class InvoiceForApproval:
    """The output of steps 1-5 that step 6 needs. Nothing more."""
    invoice_id: str
    vendor_id: Optional[str]           # None if the vendor isn't in the vendor master
    vendor_name: str
    invoice_date: date
    currency: str
    total: Decimal                     # invoice currency
    total_cad: Decimal                 # already FX-converted in step 2/4
    department_id: str
    requester_user_id: str
    po_id: Optional[str] = None
    submitted_by_user_id: Optional[str] = None   # AP clerk who keyed it, if any
    flags: list[ValidationFlag] = field(default_factory=list)


@dataclass
class ApprovalStep:
    step_no: int
    role: str                          # dept_manager | finance_manager | controller_admin | cfo
    assigned_user_id: str
    reasons: list[str]
    rule_ids: list[str]
    routed_to_user_id: str             # who the rule originally pointed at
    resolution_notes: list[str] = field(default_factory=list)  # delegation / escalation trail
    delegated_from_user_id: Optional[str] = None   # set only by P08 (on-leave delegation)
    status: str = "waiting"            # waiting | pending | approved | rejected
    acted_by_user_id: Optional[str] = None
    acted_on_behalf_of: Optional[str] = None
    acted_at: Optional[str] = None
    comment: Optional[str] = None


@dataclass
class Workflow:
    invoice_id: str
    status: str                        # on_hold | pending_approval | approved | rejected
    amount_cad: Decimal
    routing_amount_cad: Decimal        # may exceed amount_cad if a split was detected
    steps: list[ApprovalStep]
    flags: list[ValidationFlag]
    hold_reasons: list[str] = field(default_factory=list)
    requester_user_id: str = ""
    submitted_by_user_id: Optional[str] = None

    def current_step(self) -> Optional[ApprovalStep]:
        return next((s for s in self.steps if s.status == "pending"), None)

    def signers(self) -> set[str]:
        """Everyone who approved. Step 7 uses this to enforce P11."""
        return {s.acted_by_user_id for s in self.steps
                if s.status == "approved" and s.acted_by_user_id}


class ApprovalError(Exception):
    """Raise-to-HTTP: FORBIDDEN -> 403, CONFLICT -> 409, NOT_FOUND -> 404, INVALID -> 400."""
    def __init__(self, kind: str, code: str, message: str):
        super().__init__(f"{kind}/{code}: {message}")
        self.kind, self.code, self.message = kind, code, message


# ============================== reference data ==============================

@dataclass
class AmountTier:
    rule_id: str
    over_cad: Decimal                  # tier applies when amount > over_cad (0 for the base tier)
    chain: list[str]


class Directory:
    """Users, departments, vendors and parsed policies loaded from the dataset CSVs."""

    def __init__(self, data_dir: Path):
        rd = lambda name: list(csv.DictReader(open(data_dir / name, newline="", encoding="utf-8")))
        self.users = {u["user_id"]: u for u in rd("users.csv")}
        self.departments = {d["department_id"]: d for d in rd("departments.csv")}
        self.vendors = {v["vendor_id"]: v for v in rd("vendors.csv")}
        self.policies = {p["rule_id"]: p for p in rd("approval_policies.csv")}
        self.tiers = self._parse_tiers()

    def _parse_tiers(self) -> list[AmountTier]:
        tiers = []
        for p in self.policies.values():
            if p["rule_type"] != "approval":
                continue
            m = re.search(r"Invoice total (up to|over) \$([\d,]+)", p["condition"])
            if not m:
                continue
            chain = [r.strip() for r in p["required"].split(">")]
            over = Decimal(0) if m.group(1) == "up to" else Decimal(m.group(2).replace(",", ""))
            tiers.append(AmountTier(p["rule_id"], over, chain))
        if not tiers:
            raise ValueError("No amount tiers found in approval_policies.csv")
        return sorted(tiers, key=lambda t: t.over_cad)

    def tier_for(self, amount_cad: Decimal) -> AmountTier:
        chosen = self.tiers[0]
        for t in self.tiers:
            if amount_cad > t.over_cad:
                chosen = t
        return chosen

    # --- role -> person -----------------------------------------------------
    def base_user_for_role(self, role: str, department_id: str) -> Optional[str]:
        if role == "dept_manager":
            dept = self.departments.get(department_id)
            return dept["manager_user_id"] if dept else None
        if role == "cfo":
            return self._find(lambda u: "chief financial officer" in u["title"].lower())
        if role == "controller_admin":
            # Two controller_admins exist (Controller + CFO); prefer the non-CFO.
            return self._find(lambda u: u["role"] == "controller_admin"
                              and "chief financial officer" not in u["title"].lower())
        return self._find(lambda u: u["role"] == role)

    def _find(self, pred) -> Optional[str]:
        # Prefer active users, but return an on-leave one so delegation can kick in.
        hits = [u for u in self.users.values() if pred(u) and u["status"] != "terminated"]
        hits.sort(key=lambda u: u["status"] != "active")
        return hits[0]["user_id"] if hits else None

    def limit(self, user_id: str) -> Decimal:
        return Decimal(self.users[user_id]["approval_limit_cad"] or 0)

    def name(self, user_id: Optional[str]) -> str:
        u = self.users.get(user_id or "")
        return f"{u['full_name']} ({user_id})" if u else str(user_id)


# ================================ service ==================================

def _money(x: Decimal) -> str:
    return f"${x:,.2f}"


class ApprovalService:
    def __init__(self, directory: Directory):
        self.d = directory
        self.workflows: dict[str, Workflow] = {}
        self.audit_log: list[dict] = []

    # ------------------------------------------------------------------ audit
    def _audit(self, invoice_id: str, event: str, actor: Optional[str], **details):
        self.audit_log.append({
            "ts": datetime.now().isoformat(timespec="seconds"),
            "invoice_id": invoice_id, "event": event, "actor_user_id": actor,
            "details": details,
        })

    # ---------------------------------------------------------- split check
    def detect_split(self, inv: InvoiceForApproval,
                     recent: list[InvoiceForApproval]) -> Optional[tuple[Decimal, ValidationFlag]]:
        """Same vendor + same department within SPLIT_WINDOW_DAYS, and the combined
        total lands in a higher tier than this invoice alone -> route at the higher tier."""
        if not inv.vendor_id:
            return None
        siblings = [r for r in recent
                    if r.invoice_id != inv.invoice_id and r.vendor_id == inv.vendor_id
                    and r.department_id == inv.department_id
                    and abs((r.invoice_date - inv.invoice_date).days) <= SPLIT_WINDOW_DAYS
                    and r.total_cad > 0]
        if not siblings:
            return None
        combined = inv.total_cad + sum((s.total_cad for s in siblings), Decimal(0))
        alone, together = self.d.tier_for(inv.total_cad), self.d.tier_for(combined)
        if together.over_cad <= alone.over_cad:
            return None
        ids = ", ".join(s.invoice_id for s in siblings)
        return combined, ValidationFlag(
            "SPLIT_INVOICE_SUSPECTED",
            f"Combined with {ids} from the same vendor within {SPLIT_WINDOW_DAYS} days the total is "
            f"{_money(combined)}, which crosses the {_money(together.over_cad)} threshold "
            f"({together.rule_id}); routed at that level.",
            "warning", together.rule_id)

    # ------------------------------------------------------------- routing
    def route(self, inv: InvoiceForApproval,
              recent: Optional[list[InvoiceForApproval]] = None) -> Workflow:
        flags = list(inv.flags)
        hold: list[str] = []
        extra_finance: list[tuple[str, str]] = []   # (reason, rule_id)

        # Credit notes: nothing is paid out, but someone still signs off on applying the credit.
        amount = abs(inv.total_cad)
        routing_amount = amount
        if inv.total_cad < 0:
            flags.append(ValidationFlag("CREDIT_NOTE", f"Credit note for {_money(amount)} CAD; "
                                        "approval applies the credit, no payment is released.", "info"))

        # Split invoices bump the tier.
        if recent:
            split = self.detect_split(inv, recent)
            if split:
                routing_amount, flag = split
                flags.append(flag)

        # Vendor checks (P05, P06, plus an on-hold vendor blocks routing).
        vendor = self.d.vendors.get(inv.vendor_id or "")
        if vendor is None:
            extra_finance.append((f"Vendor '{inv.vendor_name}' is not in the vendor master", "P05"))
        else:
            if vendor["status"] == "on_hold":
                hold.append(f"Vendor {vendor['legal_name']} ({vendor['vendor_id']}) is on hold")
            if vendor["status"] == "pending_review":
                extra_finance.append((f"Vendor {vendor['legal_name']} is pending review", "P05"))
            onboarded = vendor.get("onboarded_at")
            if onboarded and (AS_OF - date.fromisoformat(onboarded)).days <= NEW_VENDOR_DAYS:
                extra_finance.append((f"Vendor onboarded {onboarded} (new vendor)", "P05"))
            if vendor["category"] == "Legal":
                extra_finance.append(("Vendor category is Legal", "P06"))

        # Requester sanity.
        requester = self.d.users.get(inv.requester_user_id)
        if requester is None:
            hold.append(f"Requester {inv.requester_user_id} is not a known user")
        elif requester["status"] == "terminated":
            flags.append(ValidationFlag("REQUESTER_TERMINATED",
                                        f"Requester {self.d.name(inv.requester_user_id)} was terminated "
                                        f"on {requester['status_since']}", "warning"))

        # Flags from steps 4/5.
        for f in flags:
            effect = FLAG_EFFECTS.get(f.code, "hold" if f.severity == "block" else "info")
            if effect == "hold":
                hold.append(f"{f.code}: {f.message}")
            elif effect == "finance_review":
                extra_finance.append((f"{f.code}: {f.message}", f.rule_id or "P12"))

        # Build the role chain: amount tier first, then the finance step if needed.
        tier = self.d.tier_for(routing_amount)
        chain: list[tuple[str, list[str], list[str]]] = [
            (role, [f"{_money(routing_amount)} CAD falls under {tier.rule_id}: "
                    f"{self.d.policies[tier.rule_id]['condition']}"], [tier.rule_id])
            for role in tier.chain
        ]
        if extra_finance:
            fm = next((c for c in chain if c[0] == "finance_manager"), None)
            if fm is None:
                fm = ("finance_manager", [], [])
                insert_at = 1 if chain and chain[0][0] == "dept_manager" else 0
                chain.insert(insert_at, fm)
            for reason, rid in extra_finance:
                fm[1].append(reason)
                fm[2].append(rid)

        # Resolve roles to people.
        steps: list[ApprovalStep] = []
        taken: set[str] = set()
        excluded = {inv.requester_user_id} | ({inv.submitted_by_user_id} if inv.submitted_by_user_id else set())
        for i, (role, reasons, rule_ids) in enumerate(chain, start=1):
            base = self.d.base_user_for_role(role, inv.department_id)
            if base is None:
                hold.append(f"No user holds role '{role}' for department {inv.department_id}")
                continue
            assigned, notes, extra_rules, delegated_from = self._resolve(base, excluded | taken)
            if assigned is None:
                hold.append(f"No eligible approver for step {i} ({role}): " + "; ".join(notes))
                continue
            taken.add(assigned)
            steps.append(ApprovalStep(i, role, assigned, reasons, sorted(set(rule_ids + extra_rules)),
                                      routed_to_user_id=base, resolution_notes=notes,
                                      delegated_from_user_id=delegated_from))

        # Someone on the chain has to have the authority for the amount.
        if steps and max(self.d.limit(s.assigned_user_id) for s in steps) < routing_amount:
            hold.append(f"No approver on the chain has an approval limit >= {_money(routing_amount)}")

        status = "on_hold" if hold else "pending_approval"
        if steps and status == "pending_approval":
            steps[0].status = "pending"

        wf = Workflow(inv.invoice_id, status, amount, routing_amount, steps, flags, hold,
                      inv.requester_user_id, inv.submitted_by_user_id)
        self.workflows[inv.invoice_id] = wf
        self._audit(inv.invoice_id, "approval_routed", None, status=status,
                    chain=[(s.role, s.assigned_user_id) for s in steps], hold_reasons=hold)
        return wf

    def _resolve(self, user_id: str, excluded: set[str]) -> tuple[Optional[str], list[str], list[str], Optional[str]]:
        """Walk from the policy-assigned user to someone who can actually sign:
        on leave -> named delegate (P08); terminated/missing delegate -> manager;
        requester / already on the chain -> their manager (P07 + one-signature-per-person)."""
        notes: list[str] = []
        rules: list[str] = []
        delegated_from: Optional[str] = None
        seen: set[str] = set()
        current: Optional[str] = user_id
        while current and current not in seen:
            seen.add(current)
            u = self.d.users.get(current)
            if u is None:
                notes.append(f"{current} not found")
                return None, notes, rules, None
            if u["status"] == "on_leave":
                nxt = u["delegate_user_id"] or u["manager_id"]
                via = "delegate" if u["delegate_user_id"] else "manager (no delegate set)"
                notes.append(f"{self.d.name(current)} on leave since {u['status_since']}; "
                             f"routed to {via} {self.d.name(nxt)}")
                rules.append("P08")
                delegated_from = current
                current = nxt
                continue
            if u["status"] == "terminated":
                delegated_from = None
                notes.append(f"{self.d.name(current)} terminated; escalated to manager {self.d.name(u['manager_id'])}")
                current = u["manager_id"]
                continue
            if current in excluded:
                notes.append(f"{self.d.name(current)} is the requester/submitter or already signs another "
                             f"step; escalated to manager {self.d.name(u['manager_id'])}")
                rules.append("P07")
                delegated_from = None          # escalation, not delegation
                current = u["manager_id"] or None
                continue
            return current, notes, rules, delegated_from
        notes.append("escalation chain exhausted")
        return None, notes, rules, None

    # ---------------------------------------------------------------- acting
    def act(self, invoice_id: str, actor_user_id: str, action: str,
            comment: Optional[str] = None, now: Optional[datetime] = None) -> Workflow:
        """THE server-side gate. Every approve/reject request must go through here."""
        now = now or datetime.now()
        try:
            wf = self.workflows.get(invoice_id)
            if wf is None:
                raise ApprovalError("NOT_FOUND", "NO_WORKFLOW", f"No approval workflow for {invoice_id}")
            if action not in ("approve", "reject"):
                raise ApprovalError("INVALID", "BAD_ACTION", f"Unknown action '{action}'")
            if wf.status != "pending_approval":
                raise ApprovalError("CONFLICT", "NOT_PENDING", f"Invoice is {wf.status}, not pending approval")

            actor = self.d.users.get(actor_user_id)
            if actor is None:
                raise ApprovalError("FORBIDDEN", "UNKNOWN_USER", "Unknown user")
            if actor["status"] != "active":
                raise ApprovalError("FORBIDDEN", "USER_INACTIVE", f"User is {actor['status']}")
            if actor_user_id in (wf.requester_user_id, wf.submitted_by_user_id):
                raise ApprovalError("FORBIDDEN", "SELF_APPROVAL", "You cannot approve your own request (P07)")
            if actor["role"] in ("auditor", "employee", "ap_clerk"):
                raise ApprovalError("FORBIDDEN", "ROLE_CANNOT_APPROVE", f"Role '{actor['role']}' cannot approve")
            if actor_user_id in wf.signers():
                raise ApprovalError("FORBIDDEN", "ALREADY_SIGNED", "You already approved a step on this invoice")

            step = wf.current_step()
            assert step is not None
            on_behalf_of = None
            if actor_user_id != step.assigned_user_id:
                # Late delegation: the assignee went on leave after routing.
                assignee = self.d.users[step.assigned_user_id]
                if assignee["status"] == "on_leave" and assignee["delegate_user_id"] == actor_user_id:
                    on_behalf_of = step.assigned_user_id
                else:
                    raise ApprovalError("FORBIDDEN", "NOT_ASSIGNED",
                                        f"Step {step.step_no} ({step.role}) is assigned to "
                                        f"{self.d.name(step.assigned_user_id)}")
            if action == "reject" and not (comment and comment.strip()):
                raise ApprovalError("INVALID", "COMMENT_REQUIRED", "A rejection needs a reason")
        except ApprovalError as e:
            # Denied attempts are part of the audit trail too.
            self._audit(invoice_id, "approval_denied", actor_user_id, action=action, code=e.code, reason=e.message)
            raise

        step.status = "approved" if action == "approve" else "rejected"
        step.acted_by_user_id = actor_user_id
        step.acted_on_behalf_of = on_behalf_of or step.delegated_from_user_id
        step.acted_at = now.isoformat(timespec="seconds")
        step.comment = comment

        if action == "reject":
            wf.status = "rejected"
        else:
            nxt = next((s for s in wf.steps if s.status == "waiting"), None)
            if nxt:
                nxt.status = "pending"
            else:
                wf.status = "approved"

        self._audit(invoice_id, f"step_{step.status}", actor_user_id, step_no=step.step_no, role=step.role,
                    on_behalf_of=step.acted_on_behalf_of, comment=comment, workflow_status=wf.status)
        return wf

    # ------------------------------------------------------------- UI reads
    def inbox_for(self, user_id: str) -> list[Workflow]:
        """Invoices waiting on this user (including ones delegated to them after routing)."""
        out = []
        for wf in self.workflows.values():
            s = wf.current_step()
            if not s or wf.status != "pending_approval":
                continue
            a = self.d.users[s.assigned_user_id]
            if s.assigned_user_id == user_id or (a["status"] == "on_leave" and a["delegate_user_id"] == user_id):
                out.append(wf)
        return out

    def explain(self, invoice_id: str) -> str:
        wf = self.workflows[invoice_id]
        lines = [f"{invoice_id}: {wf.status}  amount {_money(wf.amount_cad)} CAD"
                 + (f" (routed as {_money(wf.routing_amount_cad)})" if wf.routing_amount_cad != wf.amount_cad else "")]
        for h in wf.hold_reasons:
            lines.append(f"  HOLD  {h}")
        for f in wf.flags:
            lines.append(f"  FLAG  [{f.code}] {f.message}")
        for s in wf.steps:
            who = self.d.name(s.assigned_user_id)
            lines.append(f"  {s.step_no}. {s.role:<16} {who:<28} {s.status:<9} rules={','.join(s.rule_ids)}")
            for r in s.reasons:
                lines.append(f"       why: {r}")
            for n in s.resolution_notes:
                lines.append(f"       -> {n}")
            if s.acted_by_user_id:
                lines.append(f"       acted by {self.d.name(s.acted_by_user_id)} at {s.acted_at}"
                             + (f" on behalf of {self.d.name(s.acted_on_behalf_of)}" if s.acted_on_behalf_of else ""))
        return "\n".join(lines)


# ============================ dataset helpers ==============================

def invoice_from_row(row: dict) -> InvoiceForApproval:
    """Adapter for data/invoices.csv rows. Your step-5 output should map onto the same fields."""
    return InvoiceForApproval(
        invoice_id=row["invoice_id"], vendor_id=row["vendor_id"] or None, vendor_name=row["vendor_id"],
        invoice_date=date.fromisoformat(row["invoice_date"]), currency=row["currency"],
        total=Decimal(row["total"]), total_cad=Decimal(row["total_cad"]),
        department_id=row["department_id"], requester_user_id=row["requester_user_id"],
        po_id=row["po_id"] or None,
    )


def replay_history(svc: ApprovalService, data_dir: Path) -> None:
    """Route every historical invoice and compare the role chain with approvals.csv.
    Mismatches are either our bugs or the 'real-world mess' in the history - read them."""
    invoices = [invoice_from_row(r) for r in csv.DictReader(open(data_dir / "invoices.csv"))]
    hist: dict[str, list[dict]] = {}
    for a in csv.DictReader(open(data_dir / "approvals.csv")):
        hist.setdefault(a["invoice_id"], []).append(a)

    by_vendor_window = sorted(invoices, key=lambda i: i.invoice_date)
    mismatches = []
    for inv in invoices:
        recent = [r for r in by_vendor_window if abs((r.invoice_date - inv.invoice_date).days) <= SPLIT_WINDOW_DAYS]
        wf = svc.route(inv, recent)
        ours = [s.role for s in wf.steps]
        theirs = [a["approver_role"] for a in sorted(hist.get(inv.invoice_id, []), key=lambda a: int(a["step_no"]))]
        rejected_early = any(a["action"] == "rejected" for a in hist.get(inv.invoice_id, []))
        same = ours == theirs or (rejected_early and ours[: len(theirs)] == theirs)
        if not same:
            mismatches.append((inv, ours, theirs, wf))
    svc.workflows.clear()
    svc.audit_log.clear()

    print(f"Replayed {len(invoices)} historical invoices; {len(mismatches)} differ from approvals.csv role chains.")
    print("(Routing uses CURRENT user statuses, so leave/delegation differences are expected.)")
    for inv, ours, theirs, wf in mismatches[:12]:
        extra = "; ".join(f.code for f in wf.flags) or "-"
        print(f"  {inv.invoice_id} {inv.vendor_id} {_money(inv.total_cad):>12}  ours={ours}  history={theirs}  flags={extra}")


def demo(svc: ApprovalService) -> None:
    """Scripted scenario that exercises the rules judges will poke at."""
    print("\n=== Demo: Facilities invoice $18,000 (Liam on leave -> delegate Elise, who is also the FM) ===")
    inv = InvoiceForApproval("DEMO-1", "V036", "demo vendor", date(2026, 11, 2), "CAD",
                             Decimal("18000"), Decimal("18000"), "D07", "U037")
    wf = svc.route(inv)
    print(svc.explain("DEMO-1"))

    def attempt(actor, action="approve", comment=None):
        try:
            svc.act("DEMO-1", actor, action, comment)
            print(f"  OK      {svc.d.name(actor)} {action}")
        except ApprovalError as e:
            print(f"  DENIED  {svc.d.name(actor)} {action}: {e.code} - {e.message}")

    attempt("U037")                      # requester tries to approve own bill
    attempt("U006")                      # auditor is read-only
    attempt(wf.steps[1].assigned_user_id)  # step 2 approver tries to jump the queue
    attempt(wf.steps[0].assigned_user_id)  # correct step 1
    attempt(wf.steps[0].assigned_user_id)  # same person tries step 2
    attempt(wf.steps[1].assigned_user_id)  # correct step 2
    print(svc.explain("DEMO-1"))
    print("  signers (step 7 must exclude these from release):", sorted(wf.signers()))

    print("\n=== Demo: Operations manager Dev (U007) is the requester -> escalates to his manager ===")
    svc.route(InvoiceForApproval("DEMO-5", "V001", "Polar Freight", date(2026, 11, 2), "CAD",
                                 Decimal("3000"), Decimal("3000"), "D01", "U007"))
    print(svc.explain("DEMO-5"))
    try:
        svc.act("DEMO-5", "U007", "approve")
    except ApprovalError as e:
        print(f"  DENIED  Dev approve: {e.code} - {e.message}")

    print("\n=== Demo: pending_review vendor (Riverbend Catering V054), small amount ===")
    svc.route(InvoiceForApproval("DEMO-2", "V054", "Riverbend Catering", date(2026, 11, 1), "CAD",
                                 Decimal("1200"), Decimal("1200"), "D02", "U023"))
    print(svc.explain("DEMO-2"))

    print("\n=== Demo: on-hold lookalike vendor (V053) + duplicate flag from step 5 ===")
    svc.route(InvoiceForApproval("DEMO-3", "V053", "Great Lakes Carriers Incorporated", date(2026, 11, 1), "CAD",
                                 Decimal("9800"), Decimal("9800"), "D01", "U014",
                                 flags=[ValidationFlag("DUPLICATE_SUSPECTED", "Matches AP-00412 (inv# 4471 vs ST4471)", "block")]))
    print(svc.explain("DEMO-3"))

    print("\n=== Demo: split invoices, two $9,800 bills same vendor same day ===")
    a = InvoiceForApproval("DEMO-4a", "V001", "Polar Freight", date(2026, 11, 2), "CAD",
                           Decimal("9800"), Decimal("9800"), "D01", "U013")
    b = InvoiceForApproval("DEMO-4b", "V001", "Polar Freight", date(2026, 11, 2), "CAD",
                           Decimal("9800"), Decimal("9800"), "D01", "U019")
    svc.route(b, recent=[a, b])
    print(svc.explain("DEMO-4b"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(Path.home() / "Downloads/brim_ap_dataset/data"))
    args = ap.parse_args()
    data_dir = Path(args.data).expanduser()
    service = ApprovalService(Directory(data_dir))
    replay_history(service, data_dir)
    demo(service)
