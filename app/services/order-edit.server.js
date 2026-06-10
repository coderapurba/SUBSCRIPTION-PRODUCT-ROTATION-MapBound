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
        calculatedLineItem { id }
        userErrors { field message }
      }
    }
  `, { id: calcOrderId, variantId, quantity });

  const errors = data?.data?.orderEditAddVariant?.userErrors;
  if (errors?.length) throw new Error(`orderEditAddVariant: ${errors[0].message}`);
  return data.data.orderEditAddVariant.calculatedLineItem.id;
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
  if (errors?.length) throw new Error(`orderEditCommit: ${errors[0].message}`);
}

// Returns the actual amount charged for a line item.
// Loop sets final_line_price="0.00" on subscription orders.
// total_discount is only populated on Shopify Plus plans.
// discount_allocations[] is available on all plans and is the most reliable source.
function lineTotal(li) {
  const finalPrice = parseFloat(li.final_line_price);
  if (Number.isFinite(finalPrice) && finalPrice > 0) return finalPrice;

  const linePrice = parseFloat(li.price) * li.quantity;

  // Sum discount_allocations (available on all Shopify plans)
  const allocated = (li.discount_allocations || [])
    .reduce((sum, d) => sum + parseFloat(d.amount || "0"), 0);

  // Fall back to total_discount (Shopify Plus only) if allocations sum to zero
  const totalDiscount = allocated > 0 ? allocated : parseFloat(li.total_discount || "0");

  return linePrice - totalDiscount;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function performOrderEdit({ admin, orderGid, targetLineItems, nextItem, currency }) {
  // ── 1. Case 1 vs Case 2 ────────────────────────────────────────────────────
  const nextVariants = await getProductVariants(admin, nextItem.productId);
  const nextVariantTitleMap = new Map(nextVariants.map((v) => [v.title, v]));

  const targetTitles = targetLineItems.map((li) => li.variant_title || "Default Title");
  const allTitlesMatch =
    targetTitles.length > 0 &&
    targetTitles.every((t) => nextVariantTitleMap.has(t));

  console.log(`[order-edit] order=${orderGid} case=${allTitlesMatch ? "2 (variant match)" : "1 (default variant)"} targetLineItems=${targetLineItems.length}`);

  // ── 2. Begin edit ──────────────────────────────────────────────────────────
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

  // ── 4. Add rotation items with correct pricing ────────────────────────────
  if (allTitlesMatch) {
    // Case 2: each target variant title exists in the rotation product — swap per variant
    for (const li of targetLineItems) {
      const title = li.variant_title || "Default Title";
      const match = nextVariantTitleMap.get(title);
      if (!match) continue;

      const addedLineItemId = await addVariant(admin, calcOrderId, match.id, li.quantity);
      // match.price = live catalog price from getProductVariants
      const listedTotal = parseFloat(match.price) * li.quantity;
      const targetTotal = lineTotal(li);
      // Shopify applies fixedValue discount per unit — divide by qty to get correct line total
      const discountPerUnit = (listedTotal - targetTotal) / li.quantity;
      console.log(`[order-edit] case2 variant=${title} listedTotal=${listedTotal} targetTotal=${targetTotal} discountPerUnit=${discountPerUnit.toFixed(4)}`);
      await addFixedDiscount(admin, calcOrderId, addedLineItemId, discountPerUnit, currency);
    }
  } else {
    // Case 1: default variant — add one line item per target line item.
    // A single combined line (qty=sum) can't represent e.g. 28.10+28.11=56.21 because
    // Shopify's fixedValue discount is per-unit and 56.21/2=28.105 isn't representable
    // in 2 decimal places. Adding separately keeps each price exact.
    const rotationVariant = nextVariants.find((v) => v.id === nextItem.variantId);
    const variantPrice = rotationVariant
      ? parseFloat(rotationVariant.price)
      : parseFloat(nextItem.price || "0");

    for (const li of targetLineItems) {
      const listedForThis = variantPrice * li.quantity;
      const targetForThis = lineTotal(li);
      const discountPerUnit = (listedForThis - targetForThis) / li.quantity;
      console.log(`[order-edit] case1 qty=${li.quantity} variantPrice=${variantPrice} listed=${listedForThis.toFixed(2)} target=${targetForThis.toFixed(2)} discountPerUnit=${discountPerUnit.toFixed(4)}`);
      const addedLineItemId = await addVariant(admin, calcOrderId, nextItem.variantId, li.quantity);
      await addFixedDiscount(admin, calcOrderId, addedLineItemId, discountPerUnit, currency);
    }
  }

  // ── 5. Commit ──────────────────────────────────────────────────────────────
  await commitOrderEdit(admin, calcOrderId);
  console.log(`[order-edit] committed successfully for order=${orderGid}`);
}
