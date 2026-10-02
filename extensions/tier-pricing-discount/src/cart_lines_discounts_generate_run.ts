import {
  Input,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountSelectionStrategy,
  ProductDiscountCandidateFixedAmount,
} from "../generated/api";

type Tier = {
  qty: number;
  price: number;
};

/**
 * A single promo code entry stored in the shop metafield custom.promo_codes.
 *
 * JSON shape (array):
 *   [
 *     { "code": "SUMMER10", "type": "percentage", "value": 10, "expires": "2026-12-31" },
 *     { "code": "FLAT20",   "type": "fixed",      "value": 20 }
 *   ]
 *
 * - type "percentage" — takes value% off the already-tiered price per line item
 * - type "fixed"      — takes $value off each line item (capped at item price)
 * - expires           — optional ISO date string; code is ignored on/after that date
 */
type PromoCode = {
  code: string;
  type: "percentage" | "fixed";
  value: number;
  expires?: string;
};

/**
 * Parse tier data from the price_chart metafield.
 *
 * Supports two JSON shapes:
 *
 * Shape A — plain JSON metafield (recommended for Functions):
 *   [{ "tab_key": "embroidery", "quantities": [1,2,6,12], "prices": [35,30,25,19.25] }]
 *
 * Shape B — metaobject-style (nested .value wrappers, as used in Liquid):
 *   [{ "tab_key": { "value": "embroidery" }, "quantity_labels": { "value": ["1+","2+"] }, "price_values": { "value": ["$35","$30"] } }]
 *
 * Returns a map of normalised tab_key → Tier[]
 */
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
    // Support both Shape A and Shape B for tab_key
    const key: string = String(
      chart?.tab_key?.value ?? chart?.tab_key ?? ""
    ).toLowerCase().trim();

    // Shape A: quantities[] + prices[]
    // Shape B: quantity_labels.value[] + price_values.value[]
    const qtyLabels: any[] =
      chart?.quantities ??
      chart?.quantity_labels?.value ??
      chart?.quantity_labels ??
      [];

    const priceValues: any[] =
      chart?.prices ??
      chart?.price_values?.value ??
      chart?.price_values ??
      [];

    if (!key || !qtyLabels.length || !priceValues.length) continue;

    const tiers: Tier[] = [];
    for (let i = 0; i < qtyLabels.length; i++) {
      const qty = parseInt(String(qtyLabels[i]).replace(/\D/g, ""), 10);
      const price = parseFloat(String(priceValues[i]).replace(/[^0-9.]/g, ""));
      if (!isNaN(qty) && !isNaN(price)) {
        tiers.push({ qty, price });
      }
    }

    if (tiers.length) result[key] = tiers;
  }

  return result;
}

/** Return the per-unit price for the given total quantity from a tier list. */
function getTierPrice(qty: number, tiers: Tier[]): number {
  let price = tiers[0].price;
  for (const tier of tiers) {
    if (qty >= tier.qty) price = tier.price;
  }
  return price;
}

/**
 * Normalise a patch type string to a tab_key-style slug so it matches
 * what's stored in the metafield.
 * e.g. "Vegan Leather" → "vegan-leather", "Embroidery" → "embroidery"
 */
function toPatchKey(patchType: string): string {
  return patchType.toLowerCase().trim().replace(/\s+/g, "-");
}

/** Hardcoded addon tiers — same for all 4 addon products */
const ADDON_TIERS: Tier[] = [
  { qty: 1,   price: 5.00 },
  { qty: 48,  price: 4.50 },
  { qty: 96,  price: 4.00 },
  { qty: 144, price: 3.50 },
];

/**
 * Parse the shop metafield custom.promo_codes.
 * Returns a Map of uppercased code → PromoCode (only active/non-expired entries).
 */
function parsePromoCodes(raw: string | null | undefined): Map<string, PromoCode> {
  const map = new Map<string, PromoCode>();
  if (!raw) return map;
  let list: any[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return map;
  }
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  for (const item of list) {
    if (!item?.code || !item?.type || item?.value == null) continue;
    const type = String(item.type).toLowerCase();
    if (type !== "percentage" && type !== "fixed") continue;
    const value = parseFloat(item.value);
    if (isNaN(value) || value <= 0) continue;
    // Skip expired codes
    if (item.expires && String(item.expires) < today) continue;
    const code = String(item.code).toUpperCase().trim();
    map.set(code, { code, type: type as "percentage" | "fixed", value, expires: item.expires });
  }
  return map;
}

export function cartLinesDiscountsGenerateRun(input: Input): CartLinesDiscountsGenerateRunResult {

  // ── 0. Resolve active promo code (if any) ─────────────────────────────────
  const promoCodes = parsePromoCodes((input as any).shop?.promoCodes?.value ?? null);
  let activePromo: PromoCode | null = null;
  for (const entered of (input as any).enteredDiscountCodes ?? []) {
    const match = promoCodes.get(String(entered.code).toUpperCase().trim());
    if (match) { activePromo = match; break; }
  }

  // ── 1. Group hat lines by (bundleId + patchType) ───────────────────────────
  type Group = { lines: typeof input.cart.lines; tiers: Tier[] };
  const groups: Record<string, Group> = {};

  for (const line of input.cart.lines) {
    const variant = line.merchandise as any;
    const product = variant?.product;
    if (!product) continue;

    // Skip addon lines — they'll have their own discount tier logic later
    const isAddon = (line as any).isAddon?.value === "true";
    if (isAddon) continue;

    const productId: string = product.id;

    // Use _bundle_id line property to scope tier calculation per bundle,
    // falling back to productId for non-bundle items
    const bundleId: string =
      (line as any).attribute?.value
      ?? productId;

    // Detect patch type from variant title (e.g. "Brown/Khaki / Vegan Leather Patch")
    // Fall back to product metafield, then default to "Embroidery"
    const variantTitle: string = (variant?.title ?? "").toLowerCase();
    let rawPatchType: string = product?.patchType?.value ?? "Embroidery";
    if (variantTitle.includes("vegan")) {
      rawPatchType = "Vegan Leather";
    } else if (variantTitle.includes("embroidery")) {
      rawPatchType = "Embroidery";
    }
    const patchKey = toPatchKey(rawPatchType);
    const groupKey = `${bundleId}__${patchKey}`;

    if (!groups[groupKey]) {
      const allTiers = parsePriceChart(product?.priceChart?.value ?? null);

      // Exact match first, then fuzzy (also handles "vegan" → "vegan-leather")
      let tiers: Tier[] | undefined = allTiers[patchKey];
      if (!tiers) {
        const fallback = Object.keys(allTiers).find(
          (k) => k.includes(patchKey) || patchKey.includes(k) || k === "vegan" && patchKey === "vegan-leather"
        );
        if (fallback) tiers = allTiers[fallback];
      }

      if (!tiers?.length) continue; // no tier data → no discount

      groups[groupKey] = { lines: [], tiers };
    }

    groups[groupKey].lines.push(line);
  }

  // ── 2. Build hat discount candidates ──────────────────────────────────────
  const candidates: any[] = [];

  for (const groupKey in groups) {
    const { lines, tiers } = groups[groupKey];

    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, tiers);

    for (const line of lines) {
      const basePrice = parseFloat((line.cost as any).amountPerQuantity.amount);

      // Apply promo on top of tier price
      let effectivePrice = tierPrice;
      if (activePromo) {
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = Math.max(0, tierPrice - activePromo.value);
        }
      }

      const discountAmount = basePrice - effectivePrice;

      if (discountAmount > 0) {
        const message = activePromo
          ? `Tier Pricing + ${activePromo.code}`
          : "Tier Pricing";
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: discountAmount.toFixed(2),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message,
        });
      }
    }
  }

  // ── 3. Group addon lines by bundleId + productId, apply addon tiers ─────────
  const addonGroups: Record<string, typeof input.cart.lines> = {};

  for (const line of input.cart.lines) {
    const isAddon = (line as any).isAddon?.value === "true";
    if (!isAddon) continue;

    const variant = line.merchandise as any;
    const productId: string = variant?.product?.id ?? "unknown";
    const bundleId: string = (line as any).attribute?.value ?? productId;
    const addonGroupKey = `${bundleId}__${productId}`;

    if (!addonGroups[addonGroupKey]) addonGroups[addonGroupKey] = [];
    addonGroups[addonGroupKey].push(line);
  }

  for (const bundleId in addonGroups) {
    const lines = addonGroups[bundleId];
    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, ADDON_TIERS);

    for (const line of lines) {
      const basePrice = parseFloat((line.cost as any).amountPerQuantity.amount);

      // Apply promo on top of addon tier price
      let effectivePrice = tierPrice;
      if (activePromo) {
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = Math.max(0, tierPrice - activePromo.value);
        }
      }

      const discountAmount = basePrice - effectivePrice;

      if (discountAmount > 0) {
        const message = activePromo
          ? `Tier Pricing + ${activePromo.code}`
          : "Tier Pricing";
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: discountAmount.toFixed(2),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message,
        });
      }
    }
  }

  if (!candidates.length) {
    return { operations: [] };
  }

  const operations: any[] = [
    {
      productDiscountsAdd: {
        candidates,
        selectionStrategy: ProductDiscountSelectionStrategy.All,
      },
    },
  ];

  // Accept the promo code so Shopify marks it as applied
  if (activePromo) {
    operations.push({
      enteredDiscountCodesAccept: {
        codes: [{ code: activePromo.code }],
      },
    });
  }

  return { operations };
}
