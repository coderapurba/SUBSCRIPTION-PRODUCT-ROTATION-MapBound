/**
 * Shopify Admin GraphQL order-edit service.
 *
 * Flow:
 *   beginOrderEdit → query calculatedLineItems → setQuantity(target, 0) →
 *   addVariant(rotation) → addDiscount(if needed) → commitOrderEdit
 */

async function gql(admin, query, variables = {}) {
  const res = await admin.graphql(query, { variables });
  return res.json();
}

async function getProductVariants(admin, productId) {
  const data = await gql(admin, `
    query GetVariants($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes { id title price }
        }
      }
    }
  `, { id: productId });
  return data?.data?.product?.variants?.nodes ?? [];
}

async function unarchiveOrder(admin, orderId) {
  const data = await gql(admin, `
    mutation OrderOpen($input: OrderOpenInput!) {
      orderOpen(input: $input) {
        order { id }
        userErrors { field message }
      }
    }
  `, { input: { id: orderId } });

  const errors = data?.data?.orderOpen?.userErrors;
  if (errors?.length) {
    // Not fatal — order may already be open
    console.log(`[order-edit] orderOpen (may already be open): ${errors[0].message}`);
  } else {
    console.log(`[order-edit] orderOpen succeeded for ${orderId}`);
  }
}

async function beginOrderEdit(admin, orderId) {
  const data = await gql(admin, `
    mutation OrderEditBegin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder {
          id
          lineItems(first: 50) {
            nodes {
              id
              quantity
              variant {
                id
                product { id }
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: orderId });

  const errors = data?.data?.orderEditBegin?.userErrors;
  if (errors?.length) throw new Error(`orderEditBegin: ${errors[0].message}`);

  const calcOrder = data.data.orderEditBegin.calculatedOrder;
  return {
    calcOrderId: calcOrder.id,
    calcLineItems: calcOrder.lineItems?.nodes ?? [],
  };
}

// Returns false if the line item was already removed (concurrent webhook run processed it first)
async function setLineItemQuantity(admin, calcOrderId, calcLineItemId, quantity) {
  const data = await gql(admin, `
    mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        userErrors { field message }
      }
    }
  `, { id: calcOrderId, lineItemId: calcLineItemId, quantity });

  const errors = data?.data?.orderEditSetQuantity?.userErrors;
  if (errors?.length) {
    const msg = errors[0].message;
    if (msg.includes("cannot be edited because it is removed")) {
      return false; // concurrent run already processed this order
    }
    throw new Error(`orderEditSetQuantity: ${msg}`);
  }
  return true;
}

async function addVariant(admin, calcOrderId, variantId, quantity) {
  const data = await gql(admin, `
    mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
      orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
        calculatedLineItem {
          id
          originalUnitPriceSet {
            presentmentMoney { amount currencyCode }
            shopMoney { amount currencyCode }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: calcOrderId, variantId, quantity });

  const errors = data?.data?.orderEditAddVariant?.userErrors;
  if (errors?.length) throw new Error(`orderEditAddVariant: ${errors[0].message}`);

  const li = data.data.orderEditAddVariant.calculatedLineItem;
  // Prefer presentmentMoney (the order's display currency) — this is what the customer
  // is actually charged and is already in the correct currency for discount calculation.
  const pm = li.originalUnitPriceSet?.presentmentMoney;
  const sm = li.originalUnitPriceSet?.shopMoney;
  const money = pm?.amount && parseFloat(pm.amount) > 0 ? pm : sm;

  return {
    id: li.id,
    unitPrice: parseFloat(money?.amount ?? "0"),
    currencyCode: money?.currencyCode,
  };
}

async function addFixedDiscount(admin, calcOrderId, lineItemId, amount, currencyCode) {
  if (amount <= 0) return;
  const data = await gql(admin, `
    mutation OrderEditAddDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
      orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
        userErrors { field message }
      }
    }
  `, {
    id: calcOrderId,
    lineItemId,
    discount: {
      description: "Subscription rotation price match",
      fixedValue: { amount: amount.toFixed(2), currencyCode },
    },
  });

  const errors = data?.data?.orderEditAddLineItemDiscount?.userErrors;
  if (errors?.length) {
    console.warn(`[order-edit] addDiscount warning: ${errors[0].message}`);
  }
}

// Adds a CUSTOM line item with an arbitrary price (in the order's presentment currency).
// Used when a rotation product's real price is BELOW the amount it must be charged — Shopify
// can only discount a real variant, never surcharge it, so to make the rotation total equal
// the subscription price we add a price-override line instead. NOTE: a custom item isn't
// linked to the product variant, so inventory and app-based digital delivery don't apply to it.
async function addCustomItem(admin, calcOrderId, title, amount, currencyCode, quantity = 1) {
  const data = await gql(admin, `
    mutation OrderEditAddCustomItem($id: ID!, $title: String!, $quantity: Int!, $price: MoneyInput!) {
      orderEditAddCustomItem(id: $id, title: $title, quantity: $quantity, price: $price, requiresShipping: true, taxable: false) {
        calculatedLineItem { id }
        userErrors { field message }
      }
    }
  `, { id: calcOrderId, title, quantity, price: { amount: amount.toFixed(2), currencyCode } });

  const errors = data?.data?.orderEditAddCustomItem?.userErrors;
  if (errors?.length) throw new Error(`orderEditAddCustomItem: ${errors[0].message}`);
  return data?.data?.orderEditAddCustomItem?.calculatedLineItem?.id;
}

async function commitOrderEdit(admin, calcOrderId) {
  const data = await gql(admin, `
    mutation OrderEditCommit($id: ID!) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Subscription product rotation applied") {
        order { id }
        userErrors { field message }
      }
    }
  `, { id: calcOrderId });

  const errors = data?.data?.orderEditCommit?.userErrors;
  if (errors?.length) {
    const msg = errors[0].message;
    console.warn(`[order-edit] commitOrderEdit failed: ${msg}`);
    // "Could not save the order edit" can mean either:
    //   a) concurrent run already committed → that run's edit stands (normal)
    //   b) order is fulfilled/archived → edit is rejected by Shopify (needs visibility)
    // We flag it concurrent so the caller can log it properly either way.
    if (msg.includes("Could not save the order edit")) {
      const err = new Error(`orderEditCommit: ${msg}`);
      err.concurrent = true;
      throw err;
    }
    throw new Error(`orderEditCommit: ${msg}`);
  }
}

// Returns the amount paid for a line item in the order's PRESENTMENT currency.
// presentment_money matches originalUnitPriceSet.presentmentMoney on CalculatedLineItem,
// so the discount calculation is always in the same currency regardless of:
//   - Loop billing in a different currency than the store base (e.g. USD billing on AUD store)
//   - Multi-market stores where base currency ≠ checkout currency (e.g. BDT base + AUD market)
function lineTotal(li) {
  if (li.price_set?.presentment_money?.amount) {
    const unitPrice = parseFloat(li.price_set.presentment_money.amount);
    const linePrice = unitPrice * (li.quantity || 1);
    const discount  = (li.discount_allocations || []).reduce((sum, d) => {
      const amt = d.amount_set?.presentment_money?.amount ?? d.amount ?? "0";
      return sum + parseFloat(amt);
    }, 0);
    return linePrice - discount;
  }

  // Fallback for older webhook payloads that don't include price_set
  const finalPrice = parseFloat(li.final_line_price);
  if (Number.isFinite(finalPrice) && finalPrice > 0) return finalPrice;

  const linePrice = parseFloat(li.price) * li.quantity;
  const allocated = (li.discount_allocations || [])
    .reduce((sum, d) => sum + parseFloat(d.amount || "0"), 0);
  const totalDiscount = allocated > 0 ? allocated : parseFloat(li.total_discount || "0");
  return linePrice - totalDiscount;
}

// ─── Auto-fulfill ─────────────────────────────────────────────────────────────

// Accepts an ARRAY of rotation targets — each either a product id/GID string, or an object
// { productId, title }. All matching line items are fulfilled in ONE fulfillmentCreateV2 call
// (fulfilling them one-by-one fails for multi-product batches: fulfilling the first product
// moves the shared fulfillment order out of "OPEN", so a subsequent per-product call finds no
// open fulfillment order and silently skips the rest). Matching is by product GID for real
// products, OR by line item title for custom price-override lines (which have no product).
export async function autoFulfillRotationItems(admin, orderGid, targets) {
  const list = Array.isArray(targets) ? targets : [targets];
  const productGids = new Set();
  const titles = new Set();
  for (const t of list) {
    if (typeof t === "string") {
      productGids.add(t.startsWith("gid://") ? t : `gid://shopify/Product/${t}`);
    } else if (t) {
      if (t.productId) productGids.add(String(t.productId).startsWith("gid://") ? String(t.productId) : `gid://shopify/Product/${t.productId}`);
      if (t.title) titles.add(t.title);
    }
  }

  const data = await gql(admin, `
    query GetFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            lineItems(first: 50) {
              nodes {
                id
                remainingQuantity
                lineItem {
                  title
                  variant { product { id } }
                }
              }
            }
          }
        }
      }
    }
  `, { orderId: orderGid });

  const fulfillmentOrders = data?.data?.order?.fulfillmentOrders?.nodes ?? [];

  const toFulfill = [];
  for (const fo of fulfillmentOrders) {
    if (fo.status !== "OPEN") continue;
    const matching = (fo.lineItems?.nodes ?? []).filter((li) => {
      if ((li.remainingQuantity ?? 0) <= 0) return false;
      const pid = li.lineItem?.variant?.product?.id;
      const title = li.lineItem?.title;
      return (pid && productGids.has(pid)) || (title && titles.has(title));
    });
    if (matching.length > 0) {
      toFulfill.push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: matching.map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
      });
    }
  }

  if (toFulfill.length === 0) {
    console.log(`[order-edit] autoFulfill: no open fulfillment order found for products=[${[...productGids].join(", ")}] titles=[${[...titles].join(", ")}] on order=${orderGid}`);
    return;
  }

  const fulfillData = await gql(admin, `
    mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
  `, { fulfillment: { lineItemsByFulfillmentOrder: toFulfill, notifyCustomer: false } });

  const errors = fulfillData?.data?.fulfillmentCreateV2?.userErrors;
  if (errors?.length) {
    console.warn(`[order-edit] autoFulfill warning: ${errors[0].message}`);
  } else {
    const status = fulfillData?.data?.fulfillmentCreateV2?.fulfillment?.status;
    console.log(`[order-edit] autoFulfill succeeded for order=${orderGid} status=${status}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function performOrderEdit({ admin, orderGid, targetLineItems, batch, currency, freeRotation = false, keepTargetProduct = false, skipZeroOut = false }) {
  // `batch` is the array of rotation products to add this renewal.
  //   • batch.length === 1 → single-product rotation (Case 1/Case 2 variant matching, full
  //     price-match) — unchanged behaviour, also covers all legacy groups.
  //   • batch.length  >  1 → multi-product batch: the original subscription price is split
  //     EVENLY across the products (last absorbs the remainder cent); each added at qty 1
  //     using its stored default variant.
  const isSingle = batch.length === 1;
  const nextItem = batch[0];

  // ── 1. Case 1 vs Case 2 (single-product rotation only) ─────────────────────
  // Variant-title matching is a 1:1 swap concept; it doesn't apply to a curated multi-product
  // batch, so we only compute it (and fetch variants) for the single-product case.
  let nextVariantTitleMap = new Map();
  let allTitlesMatch = false;
  if (isSingle) {
    const nextVariants = await getProductVariants(admin, nextItem.productId);
    nextVariantTitleMap = new Map(nextVariants.map((v) => [v.title, v]));

    const targetTitles = targetLineItems.map((li) => li.variant_title || "Default Title");
    allTitlesMatch =
      targetTitles.length > 0 &&
      targetTitles.every((t) => nextVariantTitleMap.has(t));

    console.log(`[order-edit] order=${orderGid} single-product case=${allTitlesMatch ? "2 (variant match)" : "1 (default variant)"} targetLineItems=${targetLineItems.length}`);
  } else {
    console.log(`[order-edit] order=${orderGid} multi-product batch (${batch.length} products) — even price split across batch, targetLineItems=${targetLineItems.length}`);
  }

  // ── 2. Begin edit ──────────────────────────────────────────────────────────
  // Unarchive first — Digital Downloads (and similar apps) auto-fulfill and
  // archive orders within milliseconds of payment. orderOpen is a no-op on
  // already-open orders; it unblocks the edit on archived/fulfilled ones.
  await unarchiveOrder(admin, orderGid);
  const { calcOrderId, calcLineItems } = await beginOrderEdit(admin, orderGid);

  console.log(`[order-edit] calcOrderId=${calcOrderId} calcLineItems=${calcLineItems.length}`);

  // Build map: numeric variantId → CalculatedLineItem id
  // Keying by variantId (not productId) so multiple variants of the same product
  // each get their own entry and all get zeroed out correctly.
  const calcLineItemByVariantId = new Map();
  for (const cli of calcLineItems) {
    const numericVariantId = cli.variant?.id?.split("/").pop();
    if (numericVariantId) calcLineItemByVariantId.set(numericVariantId, cli.id);
  }

  // ── 3. Zero-out every target line item ────────────────────────────────────
  // Skipped on additive retry (skipZeroOut=true) — Shopify allows adding items
  // to a fulfilled order but rejects removing fulfilled line items. When the
  // order was already fulfilled before our webhook ran, we skip removal and
  // just add the rotation product alongside the original.
  //
  // Also skipped when keepTargetProduct=true — the merchant wants the original
  // subscription product to STAY in the order untouched. We leave it in place
  // and just add the rotation product alongside it (no remove + re-add churn).
  if (!skipZeroOut && !keepTargetProduct) {
    for (const li of targetLineItems) {
      const numericVariantId = String(li.variant_id);
      const calcLineItemId = calcLineItemByVariantId.get(numericVariantId);

      if (!calcLineItemId) {
        console.warn(`[order-edit] no CalculatedLineItem found for variant_id=${numericVariantId}, skipping`);
        continue;
      }

      console.log(`[order-edit] zeroing variant_id=${numericVariantId} calcLineItemId=${calcLineItemId}`);
      const zeroed = await setLineItemQuantity(admin, calcOrderId, calcLineItemId, 0);
      if (!zeroed) {
        const err = new Error("Order already processed by concurrent webhook run");
        err.concurrent = true;
        throw err;
      }
    }
  } else {
    console.log(`[order-edit] skipZeroOut=true — additive edit, keeping existing fulfilled items`);
  }

  // ── 4. Add rotation items with correct pricing ────────────────────────────
  //
  // addRotationLine adds ONE qty-1 rotation unit charged EXACTLY `chargeCents`:
  //   • real price ≥ charge → add the real variant + discount it down. Keeps the product
  //     variant link (inventory, app-based digital delivery, product-based auto-fulfill).
  //   • real price < charge → Shopify can't surcharge a variant, so remove the just-added
  //     variant and add a CUSTOM price-override line at the exact charge (merchant's choice).
  //     This is the only way to make the rotation total equal the subscription price when a
  //     product is cheaper than what it must be charged.
  // free=true → 100% discount (charge 0); always keeps the real variant.
  // All arithmetic is in integer cents of the order's PRESENTMENT currency (the price addVariant
  // returns), so the result is correct for every currency.
  async function addRotationLine(variantId, chargeCents, displayTitle, free = freeRotation) {
    const targetCents = free ? 0 : chargeCents;

    const { id: newId, unitPrice, currencyCode: variantCurrency } =
      await addVariant(admin, calcOrderId, variantId, 1);
    const cur = variantCurrency ?? currency;
    const variantCents = Math.round(unitPrice * 100);

    if (variantCents >= targetCents) {
      const discountCents = variantCents - targetCents;
      console.log(
        `[order-edit] ${displayTitle} REAL charge=${(targetCents / 100).toFixed(2)} ` +
        `variantPrice=${unitPrice.toFixed(2)} discount=${(discountCents / 100).toFixed(2)} ` +
        `currency=${cur}${free ? " [FREE]" : ""}`
      );
      if (discountCents > 0) {
        await addFixedDiscount(admin, calcOrderId, newId, discountCents / 100, cur);
      }
    } else {
      // Product cheaper than the required charge → replace with a custom price-override line.
      const removed = await setLineItemQuantity(admin, calcOrderId, newId, 0);
      if (!removed) {
        const err = new Error("Order already processed by concurrent webhook run");
        err.concurrent = true;
        throw err;
      }
      await addCustomItem(admin, calcOrderId, displayTitle, targetCents / 100, cur);
      console.log(
        `[order-edit] ${displayTitle} CUSTOM charge=${(targetCents / 100).toFixed(2)} ` +
        `(real price ${unitPrice.toFixed(2)} < charge — price-override line) currency=${cur}`
      );
    }
  }

  // Add one rotation PRODUCT priced to `chargeCents`, split into qty-1 units across the matching
  // target line item's quantity (the per-unit cent remainder goes to the last unit so the line
  // total is always exact). chargeCents here is the FULL amount for that target line item.
  async function addProductForLineItem(variantId, targetLineItem, chargeCents, displayTitle, free = freeRotation) {
    const qty = targetLineItem.quantity;
    const baseUnitCents = Math.floor(chargeCents / qty);
    for (let i = 0; i < qty; i++) {
      const isLast = i === qty - 1;
      const unitCents = isLast ? chargeCents - baseUnitCents * (qty - 1) : baseUnitCents;
      await addRotationLine(variantId, unitCents, displayTitle, free);
    }
  }

  if (isSingle) {
    if (allTitlesMatch) {
      // Case 2: rotation product has matching variant titles — swap each variant
      for (const li of targetLineItems) {
        const title = li.variant_title || "Default Title";
        const match = nextVariantTitleMap.get(title);
        if (!match) continue;
        await addProductForLineItem(match.id, li, Math.round(lineTotal(li) * 100), nextItem.productTitle);
      }
    } else {
      // Case 1: rotation product uses its default variant
      for (const li of targetLineItems) {
        await addProductForLineItem(nextItem.variantId, li, Math.round(lineTotal(li) * 100), nextItem.productTitle);
      }
    }
  } else {
    // ── Multi-product batch: even split that totals EXACTLY the subscription price ──
    // The original subscription total (sum of all target line item totals, in presentment cents)
    // is split EVENLY across the batch products (the last product absorbs the remainder cent so
    // the order total is exactly what the customer pays — no refund). Each product is added at
    // qty 1; products priced at/above their share keep their real variant, cheaper ones become a
    // custom price-override line (see addRotationLine).
    const totalCents = targetLineItems.reduce((sum, li) => sum + Math.round(lineTotal(li) * 100), 0);
    const N = batch.length;
    const baseShareCents = Math.floor(totalCents / N);

    for (let i = 0; i < N; i++) {
      const item = batch[i];
      const isLast = i === N - 1;
      const shareCents = isLast ? totalCents - baseShareCents * (N - 1) : baseShareCents;
      await addRotationLine(item.variantId, shareCents, item.productTitle, freeRotation);
    }
  }

  // ── 4b. keepTargetProduct ────────────────────────────────────────────────
  // No action needed: when keepTargetProduct=true the original line items were
  // never zeroed out in step 3, so they remain in the order as-is. We only
  // added the rotation product alongside them above. (Previously this branch
  // re-added the target product after a zero-out, which caused the original to
  // show as "Removed" and then re-added — unnecessary churn now eliminated.)

  // ── 5. Commit ──────────────────────────────────────────────────────────────
  await commitOrderEdit(admin, calcOrderId);
  console.log(`[order-edit] committed successfully for order=${orderGid}`);
}
