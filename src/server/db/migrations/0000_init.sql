CREATE TABLE "approval_policies" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"active" boolean NOT NULL,
	"rule_type" text NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"cardholder_id" text,
	"posted_date" date NOT NULL,
	"merchant_descriptor" text NOT NULL,
	"mcc" text,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"amount_cad_cents" bigint NOT NULL,
	"source" text NOT NULL,
	"receipt_attached" boolean DEFAULT false NOT NULL,
	"memo" text,
	"vendor_id" text
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"description" text NOT NULL,
	"billing_type" text NOT NULL,
	"monthly_fee_cents" bigint,
	"currency" text NOT NULL,
	"hourly_rate_cap_cents" bigint,
	"fuel_surcharge_cap_pct" numeric,
	"not_to_exceed_monthly_cents" bigint,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cost_centre" text,
	"annual_budget_cents" bigint,
	"manager_id" text
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"date" date PRIMARY KEY NOT NULL,
	"usd_to_cad" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"account_number" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"department_id" text,
	"requester_id" text,
	"issue_date" date,
	"description" text,
	"total_amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"approved_by" text
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"rate" numeric NOT NULL,
	"applies_to" text NOT NULL,
	"recoverable" boolean NOT NULL,
	"gl_account" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"title" text,
	"department_id" text,
	"manager_id" text,
	"role" text NOT NULL,
	"approval_limit_cents" bigint DEFAULT 0 NOT NULL,
	"work_province" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_since" date,
	"delegate_id" text,
	"hire_date" date,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('employee','ap_clerk','approver','finance_manager','controller_admin','auditor','system'))
);
--> statement-breakpoint
CREATE TABLE "vendor_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"institution" text,
	"transit" text,
	"account" text,
	"last4" text NOT NULL,
	"changed_at" date,
	"channel" text,
	"requested_by" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bank_accounts_status_check" CHECK ("vendor_bank_accounts"."status" IN ('pending','verified','rejected','superseded','closed')),
	CONSTRAINT "vendor_bank_accounts_currency_check" CHECK ("vendor_bank_accounts"."currency" IN ('CAD','USD')),
	CONSTRAINT "vendor_bank_accounts_two_people_check" CHECK ("vendor_bank_accounts"."verified_by" IS DISTINCT FROM "vendor_bank_accounts"."requested_by" OR "vendor_bank_accounts"."verified_by" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"category" text NOT NULL,
	"default_gl_account" text,
	"address" text,
	"province_or_state" text,
	"country" text,
	"gst_hst_number" text,
	"qst_number" text,
	"payment_terms_days" integer,
	"early_pay_discount" text,
	"preferred_payment_method" text,
	"accepts_card_payment" boolean DEFAULT false NOT NULL,
	"ap_contact_email" text,
	"requires_po" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"onboarded_at" date
);
--> statement-breakpoint
CREATE TABLE "approval_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_version" integer NOT NULL,
	"attempt" integer NOT NULL,
	"department_id" text,
	"outcome" text NOT NULL,
	"routing_cad_cents" bigint NOT NULL,
	"basis" jsonb NOT NULL,
	"excluded_approvers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attention" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hold_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_version" integer NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"also_covers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_id" text,
	"policy_version" integer,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routed_to" text,
	"assigned_to" text,
	"on_behalf_of" text,
	"resolution" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"acted_by" text,
	"acted_as" jsonb,
	"acknowledged_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_steps_decision_check" CHECK ("approval_steps"."decision" IN ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"inbox_message_id" text,
	"storage_key" text NOT NULL,
	"file_name" text,
	"mime" text,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"from_address" text,
	"subject" text,
	"body" text,
	"classification" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "invoice_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_version" integer NOT NULL,
	"source" text NOT NULL,
	"flag_key" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"related_invoice_id" text,
	"related_card_txn_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_flags_severity_check" CHECK ("invoice_flags"."severity" IN ('block','warn','info')),
	CONSTRAINT "invoice_flags_status_check" CHECK ("invoice_flags"."status" IN ('open','resolved','overridden')),
	CONSTRAINT "invoice_flags_source_check" CHECK ("invoice_flags"."source" IN ('validation','duplicates','coding')),
	CONSTRAINT "invoice_flags_override_note_check" CHECK ("invoice_flags"."status" <> 'overridden' OR length(trim(coalesce("invoice_flags"."resolution_note", ''))) > 0),
	CONSTRAINT "invoice_flags_resolver_check" CHECK ("invoice_flags"."status" = 'open' OR "invoice_flags"."resolved_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"line_type" text,
	"qty" numeric,
	"unit_price_cents" bigint,
	"amount_cents" bigint NOT NULL,
	"gl_account_code" text,
	"department_id" text,
	"gst_hst_code" text,
	"pst_qst_code" text,
	"coding_source" text,
	"coding_reason" jsonb
);
--> statement-breakpoint
CREATE TABLE "invoice_taxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"tax_code" text,
	"label" text,
	"base_cents" bigint,
	"rate" numeric,
	"amount_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"status" text NOT NULL,
	"legacy_status" text,
	"version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"document_id" text,
	"vendor_id" text,
	"vendor_name_raw" text,
	"invoice_number" text,
	"invoice_number_norm" text,
	"invoice_date" date,
	"received_date" date,
	"due_date" date,
	"currency" text,
	"subtotal_cents" bigint,
	"total_cents" bigint,
	"total_cad_cents" bigint,
	"fx_rate" numeric,
	"ship_to_province" text,
	"is_credit_note" boolean DEFAULT false NOT NULL,
	"po_id" text,
	"contract_id" text,
	"department_id" text,
	"requester_id" text,
	"extraction_raw" jsonb,
	"extraction_confidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" IN ('Received','ManualEntry','InReview','OnHold','PendingApproval','Approved','PaymentScheduled','Paid','Voided','Closed')),
	CONSTRAINT "invoices_source_check" CHECK ("invoices"."source" IN ('historical','email','upload','manual'))
);
--> statement-breakpoint
CREATE TABLE "payment_flags" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"urgency" text NOT NULL,
	"reason_code" text NOT NULL,
	"message" text NOT NULL,
	"scope" text NOT NULL,
	"vendor_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by" text,
	"cleared_at" timestamp with time zone,
	"clear_note" text,
	"cleared_automatically" boolean DEFAULT false NOT NULL,
	CONSTRAINT "payment_flags_urgency_check" CHECK ("payment_flags"."urgency" IN ('critical','high','low')),
	CONSTRAINT "payment_flags_scope_check" CHECK ("payment_flags"."scope" IN ('supplier','payment'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"invoice_id" text NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"vendor_id" text,
	"bank_account_id" integer,
	"method" text NOT NULL,
	"scheduled_date" date,
	"paid_date" date,
	"currency" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"fx_rate" numeric,
	"amount_cad_cents" bigint NOT NULL,
	"discount_taken_cents" bigint DEFAULT 0 NOT NULL,
	"reference" text,
	"status" text NOT NULL,
	"prepared_by" text,
	"released_by" text,
	"released_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"failure" jsonb,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"hold_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('scheduled','on_hold','released','settled','failed','cancelled')),
	CONSTRAINT "payments_release_not_preparer_check" CHECK ("payments"."released_by" IS DISTINCT FROM "payments"."prepared_by" OR "payments"."released_by" IS NULL),
	CONSTRAINT "payments_cancel_reason_check" CHECK ("payments"."status" <> 'cancelled' OR "payments"."cancel_reason" IS NOT NULL OR "payments"."cancelled_by" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"on_behalf_of" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"invoice_id" text,
	"payment_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_cardholder_id_users_id_fk" FOREIGN KEY ("cardholder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_gl_account_gl_accounts_account_number_fk" FOREIGN KEY ("gl_account") REFERENCES "public"."gl_accounts"("account_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_delegate_id_users_id_fk" FOREIGN KEY ("delegate_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_gl_account_gl_accounts_account_number_fk" FOREIGN KEY ("default_gl_account") REFERENCES "public"."gl_accounts"("account_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_plans" ADD CONSTRAINT "approval_plans_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_plan_id_approval_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."approval_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_routed_to_users_id_fk" FOREIGN KEY ("routed_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_on_behalf_of_users_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_inbox_message_id_inbox_messages_id_fk" FOREIGN KEY ("inbox_message_id") REFERENCES "public"."inbox_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_flags" ADD CONSTRAINT "invoice_flags_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_flags" ADD CONSTRAINT "invoice_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_gl_account_code_gl_accounts_account_number_fk" FOREIGN KEY ("gl_account_code") REFERENCES "public"."gl_accounts"("account_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_vendor_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."vendor_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_on_behalf_of_users_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bank_accounts_vendor_version_uq" ON "vendor_bank_accounts" USING btree ("vendor_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bank_accounts_one_verified_uq" ON "vendor_bank_accounts" USING btree ("vendor_id") WHERE "vendor_bank_accounts"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_plans_invoice_attempt_uq" ON "approval_plans" USING btree ("invoice_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_plan_seq_uq" ON "approval_steps" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "approval_steps_invoice_idx" ON "approval_steps" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "documents_sha256_idx" ON "documents" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_flags_identity_uq" ON "invoice_flags" USING btree ("invoice_id","source","flag_key");--> statement-breakpoint
CREATE INDEX "invoice_flags_invoice_idx" ON "invoice_flags" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_invoice_line_uq" ON "invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "invoice_taxes_invoice_idx" ON "invoice_taxes" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_vendor_number_uq" ON "invoices" USING btree ("vendor_id","invoice_number_norm") WHERE "invoices"."status" IN ('PendingApproval','Approved','PaymentScheduled','Paid') AND "invoices"."source" <> 'historical';--> statement-breakpoint
CREATE INDEX "invoices_vendor_number_idx" ON "invoices" USING btree ("vendor_id","invoice_number_norm");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_invoice_date_idx" ON "invoices" USING btree ("invoice_date");--> statement-breakpoint
CREATE INDEX "payment_flags_vendor_idx" ON "payment_flags" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "payment_flags_payment_idx" ON "payment_flags" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_invoice_attempt_uq" ON "payments" USING btree ("invoice_id","attempt_no");--> statement-breakpoint
CREATE INDEX "audit_events_invoice_idx" ON "audit_events" USING btree ("invoice_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_payment_idx" ON "audit_events" USING btree ("payment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");