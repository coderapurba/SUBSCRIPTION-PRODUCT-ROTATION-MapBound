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

/**
 * Begin an order edit and return the calculatedOrder ID along with
 * all calculated line items (each has a CalculatedLineItem.id needed
 * for setQuantity/addDiscount mutations).
 */
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

async function setLineItemQuantity(admin, calcOrderId, calcLineItemId, quantity) {
  const data = await gql(admin, `
    mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        userErrors { field message }
      }
    }
  `, { id: calcOrderId, lineItemId: calcLineItemId, quantity });

  const errors = data?.data?.orderEditSetQuantity?.userErrors;
  if (errors?.length) throw new Error(`orderEditSetQuantity: ${errors[0].message}`);
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Swap target subscription line items with the next rotation product.
 *
 * @param {object} opts
 * @param {object} opts.admin             - Shopify Admin GraphQL client
 * @param {string} opts.orderGid          - gid://shopify/Order/...
 * @param {object[]} opts.targetLineItems - Webhook line item objects for the target product
 * @param {object} opts.nextItem          - RotationItem from DB
 * @param {any} opts.lineItemSnapshot     - JSON snapshot stored on first order
 * @param {string} opts.currency          - ISO currency code
 */
export async function performOrderEdit({ admin, orderGid, targetLineItems, nextItem, lineItemSnapshot, currency }) {
  const snapshot = Array.isArray(lineItemSnapshot) ? lineItemSnapshot : [];

  // ── 1. Determine Case 1 vs Case 2 ──────────────────────────────────────────
  const nextVariants = await getProductVariants(admin, nextItem.productId);
  const nextVariantTitleMap = new Map(nextVariants.map((v) => [v.title, v]));

  const targetTitles = snapshot.map((s) => s.variantTitle);
  const allTitlesMatch =
    targetTitles.length > 0 &&
    targetTitles.every((t) => nextVariantTitleMap.has(t));

  console.log(`[order-edit] order=${orderGid} case=${allTitlesMatch ? "2 (variant match)" : "1 (default variant)"} snapshotItems=${snapshot.length} targetLineItems=${targetLineItems.length}`);

  // ── 2. Begin edit — returns calcOrderId + CalculatedLineItem list ───────────
  const { calcOrderId, calcLineItems } = await beginOrderEdit(admin, orderGid);

  console.log(`[order-edit] calcOrderId=${calcOrderId} calcLineItems=${calcLineItems.length}`);

  // Build a map: numeric product id → CalculatedLineItem id
  // (CalculatedLineItem IDs are required for setQuantity/addDiscount)
  const calcLineItemByProductId = new Map();
  for (const cli of calcLineItems) {
    const numericProductId = cli.variant?.product?.id?.split("/").pop();
    if (numericProductId) {
      calcLineItemByProductId.set(numericProductId, cli.id);
    }
  }

  // ── 3. Zero-out target line items using CalculatedLineItem IDs ──────────────
  for (const li of targetLineItems) {
    const numericProductId = String(li.product_id);
    const calcLineItemId = calcLineItemByProductId.get(numericProductId);

    if (!calcLineItemId) {
      console.warn(`[order-edit] no CalculatedLineItem found for product_id=${numericProductId}, skipping`);
      continue;
    }

    console.log(`[order-edit] zeroing product_id=${numericProductId} calcLineItemId=${calcLineItemId}`);
    await setLineItemQuantity(admin, calcOrderId, calcLineItemId, 0);
  }

  // ── 4. Add rotation items ───────────────────────────────────────────────────
  if (allTitlesMatch) {
    // Case 2: each target variant title exists in the rotation product
    for (const snap of snapshot) {
      const match = nextVariantTitleMap.get(snap.variantTitle);
      if (!match) continue;

      const addedLineItemId = await addVariant(admin, calcOrderId, match.id, snap.quantity);
      const listedTotal = parseFloat(match.price) * snap.quantity;
      const targetTotal = parseFloat(snap.finalLinePrice);
      await addFixedDiscount(admin, calcOrderId, addedLineItemId, listedTotal - targetTotal, currency);
    }
  } else {
    // Case 1: use stored default variant; combine total qty + price
    const totalQty =
      snapshot.reduce((s, x) => s + (x.quantity || 1), 0) ||
      targetLineItems.reduce((s, li) => s + li.quantity, 0);

    const totalPrice =
      snapshot.reduce((s, x) => s + parseFloat(x.finalLinePrice || "0"), 0) ||
      targetLineItems.reduce(
        (s, li) => s + parseFloat(li.final_line_price || String(parseFloat(li.price) * li.quantity)),
        0
      );

    const addedLineItemId = await addVariant(admin, calcOrderId, nextItem.variantId, totalQty);
    const listedTotal = parseFloat(nextItem.price || "0") * totalQty;
    await addFixedDiscount(admin, calcOrderId, addedLineItemId, listedTotal - totalPrice, currency);
  }

  // ── 5. Commit ───────────────────────────────────────────────────────────────
  await commitOrderEdit(admin, calcOrderId);
  console.log(`[order-edit] committed successfully for order=${orderGid}`);
}
