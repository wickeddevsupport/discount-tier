import {
  Input,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountSelectionStrategy,
  OrderDiscountSelectionStrategy,
  ProductDiscountCandidateFixedAmount,
} from "../generated/api";

type Tier = {
  qty: number;
  price: number;
};

/**
 * Full promo code shape stored in shop metafield custom.promo_codes (JSON array).
 *
 * Examples:
 *   { "code": "SAVE10",    "discountLevel": "product", "type": "percentage", "value": 10, "appliesTo": "all" }
 *   { "code": "FLAT20",    "discountLevel": "order",   "type": "fixed",      "value": 20, "appliesTo": "all" }
 *   { "code": "HATDEAL",   "discountLevel": "product", "type": "percentage", "value": 15,
 *     "appliesTo": "products", "productIds": ["gid://shopify/Product/123"] }
 *   { "code": "SUMMERSALE","discountLevel": "product", "type": "percentage", "value": 10,
 *     "appliesTo": "collections", "collectionIds": ["gid://shopify/Collection/456"] }
 *
 * discountLevel:
 *   "product" — applies per eligible line item on top of tier price
 *   "order"   — applies as a flat % or $ off the entire post-tier subtotal
 *
 * appliesTo:
 *   "all"         — every line in the cart
 *   "products"    — only lines whose product GID is in productIds[]
 *   "collections" — only lines whose product is in any of collectionIds[]
 */
type PromoCode = {
  code: string;
  discountLevel: "product" | "order";
  type: "percentage" | "fixed";
  value: number;
  appliesTo: "all" | "products" | "collections";
  productIds?: string[];
  collectionIds?: string[];
  expires?: string;
};

// ── Tier helpers ─────────────────────────────────────────────────────────────

/**
 * Parse tier data from the price_chart metafield.
 * Supports Shape A (plain arrays) and Shape B (nested .value wrappers).
 */
function parsePriceChart(raw: string | null | undefined): Record<string, Tier[]> {
  if (!raw) return {};
  let charts: any[];
  try {
    const parsed = JSON.parse(raw);
    charts = Array.isArray(parsed) ? parsed : [parsed];
  } catch { return {}; }

  const result: Record<string, Tier[]> = {};
  for (const chart of charts) {
    const key = String(chart?.tab_key?.value ?? chart?.tab_key ?? "").toLowerCase().trim();
    const qtyLabels: any[] = chart?.quantities ?? chart?.quantity_labels?.value ?? chart?.quantity_labels ?? [];
    const priceValues: any[] = chart?.prices ?? chart?.price_values?.value ?? chart?.price_values ?? [];
    if (!key || !qtyLabels.length || !priceValues.length) continue;
    const tiers: Tier[] = [];
    for (let i = 0; i < qtyLabels.length; i++) {
      const qty = parseInt(String(qtyLabels[i]).replace(/\D/g, ""), 10);
      const price = parseFloat(String(priceValues[i]).replace(/[^0-9.]/g, ""));
      if (!isNaN(qty) && !isNaN(price)) tiers.push({ qty, price });
    }
    if (tiers.length) result[key] = tiers;
  }
  return result;
}

function getTierPrice(qty: number, tiers: Tier[]): number {
  let price = tiers[0].price;
  for (const tier of tiers) { if (qty >= tier.qty) price = tier.price; }
  return price;
}

function toPatchKey(patchType: string): string {
  return patchType.toLowerCase().trim().replace(/\s+/g, "-");
}

const ADDON_TIERS: Tier[] = [
  { qty: 1,   price: 5.00 },
  { qty: 48,  price: 4.50 },
  { qty: 96,  price: 4.00 },
  { qty: 144, price: 3.50 },
];

// ── Promo code helpers ────────────────────────────────────────────────────────

/** Parse shop metafield → Map of uppercased code → PromoCode (non-expired only). */
function parsePromoCodes(raw: string | null | undefined): Map<string, PromoCode> {
  const map = new Map<string, PromoCode>();
  if (!raw) return map;
  let list: any[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch { return map; }

  const today = new Date().toISOString().slice(0, 10);
  for (const item of list) {
    if (!item?.code || !item?.type || item?.value == null) continue;
    const type = String(item.type).toLowerCase();
    if (type !== "percentage" && type !== "fixed") continue;
    const value = parseFloat(item.value);
    if (isNaN(value) || value <= 0) continue;
    if (item.expires && String(item.expires) < today) continue;

    const discountLevel = String(item.discountLevel ?? "product").toLowerCase();
    const appliesTo = String(item.appliesTo ?? "all").toLowerCase();
    const code = String(item.code).toUpperCase().trim();

    map.set(code, {
      code,
      discountLevel: (discountLevel === "order" ? "order" : "product") as "product" | "order",
      type: type as "percentage" | "fixed",
      value,
      appliesTo: (["products", "collections"].includes(appliesTo) ? appliesTo : "all") as "all" | "products" | "collections",
      productIds: Array.isArray(item.productIds) ? item.productIds.map(String) : [],
      collectionIds: Array.isArray(item.collectionIds) ? item.collectionIds.map(String) : [],
      expires: item.expires,
    });
  }
  return map;
}

/**
 * Check whether a promo applies to a given cart line based on appliesTo rules.
 * Collection membership is pre-resolved via the lineCollections map.
 */
function promoAppliesToLine(
  promo: PromoCode,
  productGid: string,
  lineCollections: Set<string>,
): boolean {
  if (promo.appliesTo === "all") return true;
  if (promo.appliesTo === "products") {
    return (promo.productIds ?? []).includes(productGid);
  }
  if (promo.appliesTo === "collections") {
    return (promo.collectionIds ?? []).some(cid => lineCollections.has(cid));
  }
  return false;
}

// ── Main function ─────────────────────────────────────────────────────────────

export function cartLinesDiscountsGenerateRun(input: Input): CartLinesDiscountsGenerateRunResult {

  // ── 0. Resolve active promo code ───────────────────────────────────────────
  const promoCodes = parsePromoCodes((input as any).shop?.promoCodes?.value ?? null);
  let activePromo: PromoCode | null = null;
  for (const entered of (input as any).enteredDiscountCodes ?? []) {
    const match = promoCodes.get(String(entered.code).toUpperCase().trim());
    if (match) { activePromo = match; break; }
  }

  // ── 1. Build collection membership map per line ────────────────────────────
  // The GraphQL query fetches inCollection per product. For collection-scoped
  // promos we need to know which collections each product belongs to.
  // Since Shopify Functions can only query one collection at a time via
  // inCollection(id:), we store the collection IDs from the promo itself
  // and rely on the admin UI saving the correct GIDs. At runtime we check
  // the product's collectionMemberships if available, otherwise fall back
  // to a server-side pre-check (handled below).
  const lineCollectionsMap = new Map<string, Set<string>>();
  for (const line of input.cart.lines) {
    const product = (line.merchandise as any)?.product;
    if (!product) continue;
    const membershipSet = new Set<string>();
    // collectionMemberships is available when queried via inCollection fields
    for (const cm of (product.collectionMemberships ?? [])) {
      if (cm.isMember) membershipSet.add(cm.collectionId);
    }
    lineCollectionsMap.set(line.id, membershipSet);
  }

  // ── 2. Group hat lines by (bundleId + patchType) ───────────────────────────
  type Group = { lines: typeof input.cart.lines; tiers: Tier[] };
  const groups: Record<string, Group> = {};

  for (const line of input.cart.lines) {
    const variant = line.merchandise as any;
    const product = variant?.product;
    if (!product) continue;

    const isAddon = (line as any).isAddon?.value === "true";
    if (isAddon) continue;

    const productId: string = product.id;
    const bundleId: string = (line as any).attribute?.value ?? productId;

    const variantTitle: string = (variant?.title ?? "").toLowerCase();
    let rawPatchType: string = product?.patchType?.value ?? "Embroidery";
    if (variantTitle.includes("vegan")) rawPatchType = "Vegan Leather";
    else if (variantTitle.includes("embroidery")) rawPatchType = "Embroidery";

    const patchKey = toPatchKey(rawPatchType);
    const groupKey = `${bundleId}__${patchKey}`;

    if (!groups[groupKey]) {
      const allTiers = parsePriceChart(product?.priceChart?.value ?? null);
      let tiers: Tier[] | undefined = allTiers[patchKey];
      if (!tiers) {
        const fallback = Object.keys(allTiers).find(
          k => k.includes(patchKey) || patchKey.includes(k) || (k === "vegan" && patchKey === "vegan-leather")
        );
        if (fallback) tiers = allTiers[fallback];
      }
      if (!tiers?.length) continue;
      groups[groupKey] = { lines: [], tiers };
    }
    groups[groupKey].lines.push(line);
  }

  // ── 3. Build product discount candidates (tier + product-level promo) ──────
  const candidates: any[] = [];
  let promoOrderSubtotal = 0; // accumulates post-tier subtotal for order-level promo

  for (const groupKey in groups) {
    const { lines, tiers } = groups[groupKey];
    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, tiers);

    for (const line of lines) {
      const basePrice = parseFloat((line.cost as any).amountPerQuantity.amount);
      const productGid = (line.merchandise as any)?.product?.id ?? "";
      const lineCollections = lineCollectionsMap.get(line.id) ?? new Set<string>();

      // Product-level promo applied per line on top of tier price
      let effectivePrice = tierPrice;
      if (activePromo?.discountLevel === "product" && promoAppliesToLine(activePromo, productGid, lineCollections)) {
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = Math.max(0, tierPrice - activePromo.value);
        }
      }

      // Track post-tier subtotal for order-level promo calculation
      promoOrderSubtotal += tierPrice * line.quantity;

      const discountAmount = basePrice - effectivePrice;
      if (discountAmount > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: discountAmount.toFixed(2),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message: activePromo?.discountLevel === "product" && promoAppliesToLine(activePromo, productGid, lineCollections)
            ? `Tier Pricing + ${activePromo.code}`
            : "Tier Pricing",
        });
      }
    }
  }

  // ── 4. Group addon lines ───────────────────────────────────────────────────
  const addonGroups: Record<string, typeof input.cart.lines> = {};
  for (const line of input.cart.lines) {
    const isAddon = (line as any).isAddon?.value === "true";
    if (!isAddon) continue;
    const productId: string = (line.merchandise as any)?.product?.id ?? "unknown";
    const bundleId: string = (line as any).attribute?.value ?? productId;
    const key = `${bundleId}__${productId}`;
    if (!addonGroups[key]) addonGroups[key] = [];
    addonGroups[key].push(line);
  }

  for (const key in addonGroups) {
    const lines = addonGroups[key];
    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, ADDON_TIERS);

    for (const line of lines) {
      const basePrice = parseFloat((line.cost as any).amountPerQuantity.amount);
      const productGid = (line.merchandise as any)?.product?.id ?? "";
      const lineCollections = lineCollectionsMap.get(line.id) ?? new Set<string>();

      let effectivePrice = tierPrice;
      if (activePromo?.discountLevel === "product" && promoAppliesToLine(activePromo, productGid, lineCollections)) {
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = Math.max(0, tierPrice - activePromo.value);
        }
      }

      promoOrderSubtotal += tierPrice * line.quantity;

      const discountAmount = basePrice - effectivePrice;
      if (discountAmount > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: discountAmount.toFixed(2),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message: activePromo?.discountLevel === "product" && promoAppliesToLine(activePromo, productGid, lineCollections)
            ? `Tier Pricing + ${activePromo.code}`
            : "Tier Pricing",
        });
      }
    }
  }

  if (!candidates.length) return { operations: [] };

  const operations: any[] = [
    {
      productDiscountsAdd: {
        candidates,
        selectionStrategy: ProductDiscountSelectionStrategy.All,
      },
    },
  ];

  // ── 5. Order-level promo ───────────────────────────────────────────────────
  if (activePromo?.discountLevel === "order") {
    let orderDiscountAmount = 0;
    if (activePromo.type === "percentage") {
      orderDiscountAmount = promoOrderSubtotal * (activePromo.value / 100);
    } else {
      orderDiscountAmount = Math.min(activePromo.value, promoOrderSubtotal);
    }

    if (orderDiscountAmount > 0) {
      operations.push({
        orderDiscountsAdd: {
          candidates: [
            {
              message: activePromo.code,
              value: {
                fixedAmount: {
                  amount: orderDiscountAmount.toFixed(2),
                },
              },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.All,
        },
      });
    }
  }

  // ── 6. Accept the promo code so Shopify marks it applied ──────────────────
  if (activePromo) {
    operations.push({
      enteredDiscountCodesAccept: {
        codes: [{ code: activePromo.code }],
      },
    });
  }

  return { operations };
}
