---
name: project-structure
description: Subscription Product Rotation — full architecture, rotation logic, services, routes, and deployment
metadata:
  type: project
---

React Router v7 · Shopify Admin GraphQL · Prisma PostgreSQL · Vercel · Polaris web components (`s-*`)

**Why:** Multi-store Shopify app that automatically rotates subscription product renewal order items per customer purchase instance. No Shopify Flow dependency.

## Database Models

- `Session` — Shopify OAuth sessions
- `ShopSetting` — per-shop on/off flag; auto-created on first webhook
- `RotationGroup` — one per target subscription product (`shop + targetProductId` unique). Holds the rotation sequence.
- `RotationItem` — ordered products inside a group. `sortOrder` controls sequence. `variantId` = default/fallback for Case 1. `isActive` toggles it out of rotation.
- `SubscriptionInstance` — one per unique customer purchase of a target product. `uniqueKey = shop:customerId:targetProductId:originalOrderId`. Stores `lineItemSnapshot` (qty + price from first order). `currentIndex` advances after each rotation.
- `RotationLog` — immutable audit entry per rotation attempt (SUCCESS | FAILED | SKIPPED).

## Services

| File | Purpose |
|------|---------|
| `app/services/webhook-verify.server.js` | Manual HMAC-SHA256 verification utility (timing-safe) |
| `app/services/rotation.server.js` | Core logic: first-order instance creation, renewal detection, index management |
| `app/services/order-edit.server.js` | Shopify order edit GraphQL mutations (begin→zero→addVariant→discount→commit) |

## Rotation Logic

**First order** (`source_name !== "subscription"`):
- Creates `SubscriptionInstance` with `currentIndex=0`
- Stores `lineItemSnapshot` (variantTitle, qty, finalLinePrice per line item)
- Does NOT modify the order

**Renewal order** (`source_name === "subscription"`):
- Finds instance by `subscriptionContractId + targetProductId` (precise) or `customerId + targetProductId` (fallback)
- Calls `performOrderEdit` with `targetLineItems` and `nextItem = rotationItems[currentIndex]`
- Advances `currentIndex = (currentIndex + 1) % activeItems.length`

**Case 1** (variant titles don't match): zero all target lines, add default variant, combined qty+price, apply discount if needed.
**Case 2** (all variant titles match): zero all, add each matched variant individually with original qty+price.

## Routes

| Route | File | Purpose |
|-------|------|---------|
| `/app` | `app._index.jsx` | Dashboard: checklist, stats, recent logs |
| `/app/rotation-groups` | `app.rotation-groups._index.jsx` | List, toggle, delete groups |
| `/app/rotation-groups/new` | `app.rotation-groups.new.jsx` | Product search → create group |
| `/app/rotation-groups/:id` | `app.rotation-groups.$id.jsx` | Edit group + add/reorder/toggle/delete items with inline product search |
| `/app/rotation-logs` | `app.rotation-logs._index.jsx` | Paginated log viewer with filters |
| `/webhooks/orders/create` | `webhooks.orders.create.jsx` | Main rotation trigger |
| `/webhooks/subscription-contracts/activate` | `webhooks.subscription-contracts.activate.jsx` | Back-fills contractId on instances |

## Deployment (Vercel + Prisma Postgres)

Build command: `npm run vercel-build` → `prisma generate && prisma db push && react-router build`

Required env vars:
- `DATABASE_URL` — pooled PostgreSQL connection string (pgBouncer/Neon)
- `DIRECT_URL` — direct connection string (for schema push)
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`

**How to apply:** When adding rotation logic changes, always update `currentIndex` atomically and write to `RotationLog`. Never skip the HMAC check (`authenticate.webhook()` handles it).
