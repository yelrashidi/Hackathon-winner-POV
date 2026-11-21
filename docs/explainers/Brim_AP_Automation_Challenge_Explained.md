# Brim AP Automation Challenge — Explained

This is less "banking" than it sounds. Brim makes corporate credit cards for businesses. The challenge is about **accounts payable (AP)**, which is how a company pays the bills it owes to its suppliers. If you understand "a bill arrives, someone checks it, the boss signs off, the money goes out, and you keep receipts," you already have the core idea. The rest is the details that make doing it properly hard.

## The story in one example

Harborline Logistics is a fictional 40-person trucking/logistics company. Follow one bill through the system you'd build:

1. **Intake.** An email arrives at `you@gmail.com` from "Speedy Tires Ltd" with a PDF attached. Your app picks it up and turns it into a *draft bill*. (Some emails are spam or "thanks for your payment!" messages, and your app should recognise that they aren't bills.)
2. **Extraction.** Your app reads the PDF and pulls out the fields: vendor = Speedy Tires, invoice #ST-4471, date Nov 3, 8 tires × $250 = $2,000, Ontario HST 13% = $260, total $2,260 CAD. Some PDFs are blurry scans, and some are in French.
3. **Coding.** "Coding" is accounting jargon for **putting the expense in the right bucket**. The company has a *chart of accounts*, which is basically a list of categories like "6100 – Vehicle Maintenance" or "6400 – Office Supplies." Your app looks at the ~450 past invoices, sees that Speedy Tires bills have always gone to Vehicle Maintenance for the Operations department, and suggests that. It also says why ("12 of the last 12 Speedy Tires invoices were coded here").
4. **Validation.** Before anyone pays, your app checks:
    - Is Speedy Tires a known, approved supplier in the *vendor master* (the company's supplier list)?
    - Is there a **purchase order (PO)**, meaning an advance "yes, buy this" record, for 8 tires? Does the price match the **contract** (say the contract caps tires at $230 each, so $250 is overcharging)?
    - Is the tax right? Delivery was to Toronto, so 13% Ontario HST is correct. If they'd charged Quebec tax on a Toronto delivery, flag it.
    - Does the math add up? (8 × 250 really is 2,000.)
5. **Duplicate check.** Have we seen this already? Maybe the same invoice came in last week as "ST4471" with a slightly different date, or someone already paid it with the company credit card.
6. **Approval.** The bill goes to the right people based on rules. For example, under $5k only the Operations manager approves, over $25k the Finance Manager also has to sign off, and a brand-new vendor always gets an extra check. If the Operations manager is on vacation, their named delegate approves, and the record says it was the delegate.
7. **Payment.** Once it's approved, someone with payment rights releases it by **EFT** (electronic funds transfer, Canada's version of a bank transfer). This is simulated, so no real money moves.
8. **Audit trail.** Months later, a tax auditor from the **CRA** (Canada Revenue Agency) asks about the $2,260 payment. Your app shows the original PDF, who coded it, who approved it and when, and when it was paid.

That's the whole product: **inbox → read → categorise → check → approve → pay → prove it.**

## The concepts that will feel unfamiliar

### Separation of duties

This is the most important finance idea in the brief. No single person should be able to push money out alone. So:

- You can't approve your own request. Say Maria in Operations orders something: her manager approves it, not Maria.
- Whoever approves a bill can't also release the payment. If the Finance Manager approved invoice #ST-4471, a different person (e.g. the Controller) has to release it.

The brief says these rules must be **enforced on the server**. Hiding the "Approve" button in the UI isn't enough. If Maria sends the API request herself, it still has to fail. Judges will test this.

### The six roles

In plain terms: Employee (submits bills), AP Clerk (does the data entry and cleanup), Approver (department manager), Finance Manager (bigger approvals, can pay up to $100k), Controller/Admin (sets the rules), and Auditor (read-only, sees everything).

### Canadian sales tax

This is a real source of bugs, so here's a quick primer:

- Ontario charges **HST** at 13% (federal and provincial combined into one tax).
- BC charges **GST** 5% plus **PST** 7%, as two separate lines.
- Quebec charges **GST** 5% plus **QST** 9.975%.
- "Recoverable" means the business gets that tax back from the government, so it's recorded separately from the expense. The dataset's tax codes table says which taxes are recoverable.

The check is: *does the tax charged match the province where the goods or services were delivered?*

### Fraud patterns hidden in the data

The brief says the data is deliberately messy, and finding the mess is part of the job. The patterns are worth knowing:

- **Changed bank details.** A classic scam: a fake email says "we changed banks, please pay this new account." That's why changing a vendor's bank account has to be a controlled action that someone verifies.
- **Split invoices.** If the approval limit is $10k, someone sends two $9,800 invoices on the same day to dodge the higher approval.
- **Lookalike senders.** For example `billing@speedytlres.com` (with an "l" in place of the "i").
- **Credit notes.** A negative invoice, meaning the supplier owes *you* money (a refund).
- **USD invoices.** These have to be converted to CAD using the FX (exchange rate) table provided.

### Reconciliation (a bonus feature)

You match the payments your app says it made against the bank statement, and explain anything left over (bank fees, mystery debits).

## How it's scored, and what that means for you

| Criterion | Weight | Practical takeaway |
|---|---|---|
| Required features (9) | 40% | They're tested on **hidden invoices**, so build general logic, not hardcoded answers |
| Technical depth (live Q&A) | 25% | Everyone on the team must be able to explain the design, including code an AI wrote |
| UI | 20% | Each role sees a different, clear screen, and flags explain themselves ("Price $250 exceeds contract cap $230") |
| Bonus | 15% | Only counts if the core works. One deep bonus beats five shallow ones |

The brief says to "focus on a few and implement them well." A realistic hackathon plan is a solid end-to-end pipeline: LLM extraction, rule-based validation, duplicate detection, and role-enforced approvals with an audit log. Then pick one bonus. "Ask questions about spend in plain language" or "flag suspicious bank changes" both fit well with agentic or LLM work.

## Is it a good fit without finance experience?

Yes. The domain knowledge you need is mostly in this doc, and the dataset hands you the rules: tax rates, approval policies and contracts. Under the hood it's a workflow app with permissions, document extraction, fuzzy matching and an event log. Those are standard software problems. The finance side mostly tells you *which checks to write*.

One thing to prepare for is the "what breaks at 100× volume" question in the Q&A. At 5,000 invoices a month, a naive duplicate check that compares every invoice to every other invoice gets slow, and running LLM extraction one invoice at a time gets expensive. Think about that early.
