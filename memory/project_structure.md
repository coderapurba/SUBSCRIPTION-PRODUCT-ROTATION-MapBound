---
name: project-structure
description: Subscription Product Rotation Shopify app — tech stack, database models, and route layout
metadata:
  type: project
---

React Router v7 + Shopify App Bridge + Prisma/SQLite + Polaris web components (`s-*` prefix).

**Database models (Prisma):**
- `Session` — Shopify OAuth session (built-in)
- `RotationGroup` — named group of products to cycle through, scoped to `shop`
- `RotationItem` — ordered product entries inside a group (`position` int)
- `SubscriptionInstance` — links a Shopify subscription contract to a rotation group; tracks `currentPosition` and `status`
- `RotationLog` — audit trail of each rotation event

**Why:** Built 2026-06-09 to manage per-subscription product rotation for client shops.
**How to apply:** When adding rotation logic, use `SubscriptionInstance.currentPosition` to track progress and write to `RotationLog` after each swap.

**Routes:**
- `/app` → Dashboard (stats + recent logs)
- `/app/rotation-groups` → CRUD list
- `/app/rotation-groups/new` → create group
- `/app/rotation-groups/:id` → edit group + manage items (inline add/delete/reorder)
- `/app/rotation-logs` → paginated log viewer with status/trigger filters
- `/webhooks/subscription-contracts/activate|cancel|update` → contract lifecycle handlers
- TOML webhooks: `subscription_contracts/activate|cancel|update` registered in `shopify.app.toml`
- Scopes include `read_subscriptions,write_subscriptions`
