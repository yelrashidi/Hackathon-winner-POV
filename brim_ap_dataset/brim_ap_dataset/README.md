# Harborline Logistics AP dataset (synthetic)

Everything here is fictional: companies, people, tax numbers and bank details. No real payments move.

**As-of date:** 2026-11-02. History runs January to October 2026. The `incoming_invoices` folder and `inbox/emails.json` hold unprocessed items to run through your system.

## Contents

| Path | Rows / files | Columns |
| --- | --- | --- |
| data/approval_policies.csv | 13 | rule_id, rule_type, condition, required, notes |
| data/approvals.csv | 474 | approval_id, invoice_id, step_no, approver_user_id, approver_role, action, acted_at, comment |
| data/bank_change_history.csv | 9 | change_id, vendor_id, changed_at, changed_by_user_id, request_channel, verified_by_callback, old_account_last4, new_account_last4 |
| data/bank_statement.csv | 354 | bank_txn_id, posted_date, description, debit, credit |
| data/card_transactions.csv | 590 | txn_id, card_id, cardholder_user_id, posted_date, merchant_descriptor, mcc, amount, currency, amount_cad, source, receipt_attached, memo |
| data/contracts.csv | 27 | contract_id, vendor_id, description, billing_type, monthly_fee, currency, hourly_rate_cap, fuel_surcharge_cap_pct, not_to_exceed_monthly, start_date, end_date, auto_renew, status |
| data/departments.csv | 8 | department_id, name, cost_centre, annual_budget_cad, manager_user_id |
| data/fx_rates.csv | 306 | date, usd_to_cad |
| data/gl_accounts.csv | 30 | account_number, name, account_type, notes |
| data/invoice_lines.csv | 809 | invoice_id, line_no, description, quantity, unit_price, amount, gl_account, department_id, gst_hst_code, pst_qst_code, line_type |
| data/invoices.csv | 426 | invoice_id, vendor_id, vendor_invoice_number, invoice_date, received_date, due_date, currency, subtotal, gst_hst_amount, pst_qst_amount, total, fx_rate_to_cad, total_cad, department_id, requester_user_id, po_id, contract_id, ship_to_province, status |
| data/payments.csv | 415 | payment_id, invoice_id, vendor_id, method, scheduled_date, paid_date, currency, amount, fx_rate_to_cad, amount_cad, discount_taken, reference, status, prepared_by, released_by |
| data/purchase_orders.csv | 52 | po_id, vendor_id, department_id, requester_user_id, issue_date, description, total_amount, currency, status, approved_by |
| data/tax_codes.csv | 6 | code, description, rate, applies_to, recoverable, gl_account |
| data/users.csv | 40 | user_id, full_name, email, title, department_id, manager_id, role, approval_limit_cad, work_province, status, status_since, delegate_user_id, hire_date |
| data/vendors.csv | 56 | vendor_id, legal_name, category, default_gl_account, address, province_or_state, country, gst_hst_number, qst_number, payment_terms_days, early_pay_discount, preferred_payment_method, accepts_card_payment, bank_institution, bank_transit, bank_account, bank_details_updated_at, ap_contact_email, requires_po, status, onboarded_at |
| incoming_invoices/ | 56 files (PDF and PNG) | one invoice per file |
| inbox/emails.json | 59 emails | email_id, from_name, from_address, to_address, subject, received_at, body, attachments |

## Notes

- Amounts in `invoices.csv` are in the invoice currency. `total_cad` converts USD invoices at the rate for the invoice date in `fx_rates.csv`.
- Taxes: provided rates are used for this exercise only. GST 5%, Ontario HST 13%, BC PST 7% on goods, Quebec QST 9.975% on the pre-tax amount. Insurance is exempt.
- Place of supply is the province the goods or services are delivered to (`ship_to_province`).
- Users with role `employee` or `ap_clerk` request invoices. `approval_limit_cad` is each user's own limit. `status` can be `active`, `on_leave` (see `delegate_user_id`) or `terminated`.
- Payment methods are `EFT`, `CHEQUE` or `CARD` (a single-use Brim virtual card). Card payments appear in `card_transactions.csv`, EFT and cheque payments in `bank_statement.csv`.
- Invoice `status` values: pending_approval, approved, scheduled, paid, rejected.
- The history and the incoming batch contain real-world mess. Finding it is part of the job.
