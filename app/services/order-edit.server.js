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

export async function autoFulfillRotationItems(admin, orderGid, rotationProductId) {
  const productGid = rotationProductId.startsWith("gid://")
    ? rotationProductId
    : `gid://shopify/Product/${rotationProductId}`;

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
    const matching = (fo.lineItems?.nodes ?? []).filter(
      (li) => li.lineItem?.variant?.product?.id === productGid && li.remainingQuantity > 0
    );
    if (matching.length > 0) {
      toFulfill.push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: matching.map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
      });
    }
  }

  if (toFulfill.length === 0) {
    console.log(`[order-edit] autoFulfill: no open fulfillment order found for product=${productGid} on order=${orderGid}`);
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

export async function performOrderEdit({ admin, orderGid, targetLineItems, nextItem, currency, freeRotation = false, keepTargetProduct = false, skipZeroOut = false }) {
  // ── 1. Case 1 vs Case 2 ────────────────────────────────────────────────────
  const nextVariants = await getProductVariants(admin, nextItem.productId);
  const nextVariantTitleMap = new Map(nextVariants.map((v) => [v.title, v]));

  const targetTitles = targetLineItems.map((li) => li.variant_title || "Default Title");
  const allTitlesMatch =
    targetTitles.length > 0 &&
    targetTitles.every((t) => nextVariantTitleMap.has(t));

  console.log(`[order-edit] order=${orderGid} case=${allTitlesMatch ? "2 (variant match)" : "1 (default variant)"} targetLineItems=${targetLineItems.length}`);

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
  if (!skipZeroOut) {
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
  // Shopify's orderEditAddLineItemDiscount fixedValue is applied PER UNIT.
  // For qty > 1 with a non-divisible total (e.g. 49.97 for qty=2 → 24.985/unit),
  // a single multi-unit add always rounds to 49.96 or 49.98.
  //
  // Fix: split every quantity into individual qty=1 adds, distributing the
  // 1-cent remainder to the last unit so the line total is always exact.
  // Uses integer-cent arithmetic throughout to avoid floating-point drift.

  // free=true  → 100% discount (rotation product when freeRotation is on)
  // free=false → price-match what customer paid (rotation product normally, or re-added target)
  async function addUnitsExact(variantId, targetLineItem, title, free = freeRotation) {
    const totalCents    = Math.round(lineTotal(targetLineItem) * 100);
    const baseUnitCents = Math.floor(totalCents / targetLineItem.quantity);

    for (let i = 0; i < targetLineItem.quantity; i++) {
      const isLast    = i === targetLineItem.quantity - 1;
      const unitCents = isLast ? totalCents - baseUnitCents * i : baseUnitCents;

      const { id: newId, unitPrice, currencyCode: variantCurrency } =
        await addVariant(admin, calcOrderId, variantId, 1);

      const variantCents  = Math.round(unitPrice * 100);
      const discountCents = free ? variantCents : variantCents - unitCents;
      const discountAmt   = discountCents / 100;

      console.log(
        `[order-edit] ${title} unit=${i+1}/${targetLineItem.quantity} ` +
        `paidPrice=${(unitCents/100).toFixed(2)} variantPrice=${unitPrice.toFixed(2)} ` +
        `discount=${discountAmt.toFixed(4)} currency=${variantCurrency ?? currency}` +
        (free ? " [FREE]" : "")
      );

      if (discountAmt > 0) {
        await addFixedDiscount(admin, calcOrderId, newId, discountAmt, variantCurrency ?? currency);
      }
    }
  }

  if (allTitlesMatch) {
    // Case 2: rotation product has matching variant titles — swap each variant
    for (const li of targetLineItems) {
      const title = li.variant_title || "Default Title";
      const match = nextVariantTitleMap.get(title);
      if (!match) continue;

      await addUnitsExact(match.id, li, `case2 variant=${title}`);
    }
  } else {
    // Case 1: rotation product uses its default variant
    for (const li of targetLineItems) {
      await addUnitsExact(nextItem.variantId, li, `case1`);
    }
  }

  // ── 4b. Re-add target items when keepTargetProduct=true ──────────────────
  // Only applies when we did the zero-out. On additive retry (skipZeroOut=true)
  // the original items were never removed so there's nothing to re-add.
  if (keepTargetProduct && !skipZeroOut) {
    console.log(`[order-edit] keepTargetProduct=true — re-adding ${targetLineItems.length} target item(s) at original price`);
    for (const li of targetLineItems) {
      const targetVariantGid = `gid://shopify/ProductVariant/${li.variant_id}`;
      await addUnitsExact(targetVariantGid, li, `reAdd variant=${li.variant_title || "Default"}`, false);
    }
  }

  // ── 5. Commit ──────────────────────────────────────────────────────────────
  await commitOrderEdit(admin, calcOrderId);
  console.log(`[order-edit] committed successfully for order=${orderGid}`);
}
