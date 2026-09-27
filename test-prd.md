# Micro-SaaS Invoicing PRD
We need a client billing system:
- Entities: Organization (id, name, plan), Invoice (id, org_id, amount, status: pending/paid, due_date), LineItem (id, invoice_id, description, rate, quantity).
- APIs:
  - GET /api/v1/invoices: list all invoices for current org
  - POST /api/v1/invoices: create new invoice with line items
  - POST /api/v1/invoices/:id/pay: mark invoice as paid
- Frontend Pages:
  - /invoices: Data table showing invoice status badges and total
  - /invoices/new: Multi-line invoice builder form
  - /invoices/[id]: Detail view with PDF download and Pay button