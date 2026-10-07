import {
  Input,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from "../generated/api";

// This one function backs two kinds of discount:
//
//  1. The "Tier Pricing" AUTOMATIC discount (no promo metafield on it).
//     -> discounts each line from its base price down to its tier price.
//
//  2. One CODE discount per promo code, created by the app's Promo Codes tab.
//     The promo settings live in the discount's `tier_pricing.promo` metafield.
//     -> discounts ONLY the promo portion, calculated on top of the tier price,
//        so Tier Pricing + promo stack exactly like before.
//
// Promo codes must exist as real Shopify discount codes: in this target,
// `enteredDiscountCodes` only contains codes Shopify itself knows about, so a
// code that only lives in a metafield is never seen (and checkout rejects it).

type Tier = { qty: number; price: number };

type Promo = {
  code: string;
  discountLevel: string; // "product" | "order"
  type: string; // "percentage" | "fixed"
  value: number;
  appliesTo: string; // "all" | "products" | "collections"
  productIds: string[]; // for "collections" the app resolves collection -> product IDs
  expires: string;
};

const ADDON_TIERS: Tier[] = [
  { qty: 1, price: 5.0 },
  { qty: 48, price: 4.5 },
  { qty: 96, price: 4.0 },
  { qty: 144, price: 3.5 },
];

function parsePriceChart(raw: string | null | undefined): Record<string, Tier[]> {
  if (!raw) return {};
  let charts: any[];
  try {
    const parsed = JSON.parse(raw);
    charts = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return {};
  }

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
  for (const tier of tiers) {
    if (qty >= tier.qty) price = tier.price;
  }
  return price;
}

function toPatchKey(patchType: string): string {
  return patchType.toLowerCase().trim().replace(/\s+/g, "-");
}

function parsePromo(raw: string | null | undefined): Promo | null {
  if (!raw) return null;
  try {
    const item = JSON.parse(raw);
    if (!item || !item.code || !item.type || item.value == null) return null;
    const value = parseFloat(item.value);
    if (isNaN(value) || value <= 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (item.expires && String(item.expires) < today) return null;
    return {
      code: String(item.code).toUpperCase().trim(),
      discountLevel: String(item.discountLevel ?? "product"),
      type: String(item.type),
      value,
      appliesTo: String(item.appliesTo ?? "all"),
      productIds: Array.isArray(item.productIds) ? item.productIds.map(String) : [],
      expires: String(item.expires ?? ""),
    };
  } catch {
    return null;
  }
}

function promoAppliesToProduct(promo: Promo, productGid: string): boolean {
  if (promo.appliesTo === "all") return true;
  // "products" and "collections" both use the resolved productIds list
  return promo.productIds.indexOf(productGid) !== -1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Returns { lineId -> tier unit price } for every line that has tier pricing.
function computeTierPrices(lines: any[]): Record<string, number> {
  const tierPriceByLine: Record<string, number> = {};

  // ── Hat lines: group by (bundleId + patchType) ──
  const groups: Record<string, { lines: any[]; tiers: Tier[] }> = {};
  for (const line of lines) {
    const variant = line.merchandise;
    const product = variant?.product;
    if (!product) continue;
    if (line.isAddon?.value === "true") continue;

    const productId: string = product.id;
    const bundleId: string = line.attribute?.value ?? productId;

    const variantTitle: string = String(variant?.title ?? "").toLowerCase();
    let rawPatchType: string = product?.patchType?.value ?? "Embroidery";
    if (variantTitle.includes("vegan")) rawPatchType = "Vegan Leather";
    else if (variantTitle.includes("embroidery")) rawPatchType = "Embroidery";

    const patchKey = toPatchKey(rawPatchType);
    const groupKey = bundleId + "__" + patchKey;

    if (!groups[groupKey]) {
      const allTiers = parsePriceChart(product?.priceChart?.value ?? null);
      let tiers: Tier[] | undefined = allTiers[patchKey];
      if (!tiers) {
        const fallback = Object.keys(allTiers).find(
          (k) => k.includes(patchKey) || patchKey.includes(k) || (k === "vegan" && patchKey === "vegan-leather"),
        );
        if (fallback) tiers = allTiers[fallback];
      }
      // Same as before: no chart on this line -> skip it, a later line in the group may supply one
      if (!tiers || !tiers.length) continue;
      groups[groupKey] = { lines: [], tiers };
    }
    groups[groupKey].lines.push(line);
  }

  for (const key in groups) {
    const g = groups[key];
    const totalQty = g.lines.reduce((sum: number, l: any) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, g.tiers);
    for (const line of g.lines) tierPriceByLine[line.id] = tierPrice;
  }

  // ── Add-on lines: group by (bundleId + productId) ──
  const addonGroups: Record<string, any[]> = {};
  for (const line of lines) {
    if (line.isAddon?.value !== "true") continue;
    const productId: string = line.merchandise?.product?.id ?? "unknown";
    const bundleId: string = line.attribute?.value ?? productId;
    const key = bundleId + "__" + productId;
    if (!addonGroups[key]) addonGroups[key] = [];
    addonGroups[key].push(line);
  }
  for (const key in addonGroups) {
    const groupLines = addonGroups[key];
    const totalQty = groupLines.reduce((sum: number, l: any) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, ADDON_TIERS);
    for (const line of groupLines) tierPriceByLine[line.id] = tierPrice;
  }

  return tierPriceByLine;
}

export function cartLinesDiscountsGenerateRun(input: Input): CartLinesDiscountsGenerateRunResult {
  const data = input as any;
  const lines: any[] = data?.cart?.lines ?? [];
  const discountClasses: string[] = data?.discount?.discountClasses ?? [];
  const hasOrderClass = discountClasses.indexOf(DiscountClass.Order) !== -1;

  if (!lines.length) return { operations: [] };

  const tierPriceByLine = computeTierPrices(lines);
  const promoRaw: string | null = data?.discount?.promo?.value ?? null;
  const promo = parsePromo(promoRaw);

  // A promo-code discount whose settings are invalid or expired gives nothing
  // (it must never fall back to tier mode, or tier pricing would apply twice).
  if (promoRaw && !promo) return { operations: [] };

  // ── Mode 1: Tier Pricing automatic discount ─────────────────────────────
  // Behaves exactly like the pre-promo version (no discount-class check here on purpose).
  if (!promo) {
    const candidates: any[] = [];
    for (const line of lines) {
      const tierPrice = tierPriceByLine[line.id];
      if (tierPrice === undefined) continue;
      const basePrice = parseFloat(line.cost.amountPerQuantity.amount);
      const discountPerItem = round2(basePrice - tierPrice);
      if (discountPerItem > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: { fixedAmount: { amount: discountPerItem.toFixed(2), appliesToEachItem: true } },
          message: "Tier Pricing",
        });
      }
    }
    if (!candidates.length) return { operations: [] };
    return {
      operations: [
        { productDiscountsAdd: { candidates, selectionStrategy: ProductDiscountSelectionStrategy.All } },
      ],
    } as any;
  }

  // ── Mode 2: promo code discount ─────────────────────────────────────────
  // Always emitted as an ORDER discount. Shopify (non-Plus) won't put two product
  // discounts on the same line, so a product-level promo would be rejected next to
  // Tier Pricing. Order discounts are applied AFTER product discounts, so the promo
  // is still calculated on the tier price. "Product-level" promos only count the
  // matching lines (all other lines are excluded from the order discount).
  if (!hasOrderClass) return { operations: [] };

  function unitAfterTier(line: any): number {
    const tierPrice = tierPriceByLine[line.id];
    const basePrice = parseFloat(line.cost.amountPerQuantity.amount);
    return tierPrice === undefined ? basePrice : Math.min(basePrice, tierPrice);
  }

  const excludedCartLineIds: string[] = [];
  let eligibleSubtotal = 0;
  let fixedTotal = 0;
  for (const line of lines) {
    const productGid: string = line.merchandise?.product?.id ?? "";
    const eligible =
      promo.discountLevel === "order" || (productGid !== "" && promoAppliesToProduct(promo, productGid));
    if (!eligible) {
      excludedCartLineIds.push(line.id);
      continue;
    }
    const unit = unitAfterTier(line);
    eligibleSubtotal += unit * line.quantity;
    fixedTotal += Math.min(promo.value, unit) * line.quantity;
  }
  if (eligibleSubtotal <= 0) return { operations: [] };

  let value: any;
  if (promo.type === "percentage") {
    value = { percentage: { value: Math.min(promo.value, 100) } };
  } else if (promo.discountLevel === "order") {
    // fixed amount off the whole order
    value = { fixedAmount: { amount: Math.min(promo.value, eligibleSubtotal).toFixed(2) } };
  } else {
    // fixed amount off EACH matching item
    value = { fixedAmount: { amount: Math.min(round2(fixedTotal), eligibleSubtotal).toFixed(2) } };
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: promo.code,
              targets: [{ orderSubtotal: { excludedCartLineIds } }],
              value,
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  } as any;
}
