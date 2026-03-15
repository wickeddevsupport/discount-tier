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

export function cartLinesDiscountsGenerateRun(input: Input): CartLinesDiscountsGenerateRunResult {

  // ── 1. Group lines by (productId + patchType) ──────────────────────────────
  // 1 black + 2 grey of the same patch type on the same product = 3 total
  // for tier calculation, then each line gets its own discount applied.
  type Group = { lines: typeof input.cart.lines; tiers: Tier[] };
  const groups: Record<string, Group> = {};

  for (const line of input.cart.lines) {
    const variant = line.merchandise as any;
    const product = variant?.product;
    if (!product) continue;

    const productId: string = product.id;

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
    const groupKey = `${productId}__${patchKey}`;

    if (!groups[groupKey]) {
      const allTiers = parsePriceChart(product?.priceChart?.value ?? null);

      // Exact match first, then fuzzy
      let tiers: Tier[] | undefined = allTiers[patchKey];
      if (!tiers) {
        const fallback = Object.keys(allTiers).find(
          (k) => k.includes(patchKey) || patchKey.includes(k)
        );
        if (fallback) tiers = allTiers[fallback];
      }

      if (!tiers?.length) continue; // no tier data → no discount

      groups[groupKey] = { lines: [], tiers };
    }

    groups[groupKey].lines.push(line);
  }

  // ── 2. Build discount candidates ───────────────────────────────────────────
  const candidates: any[] = [];

  for (const groupKey in groups) {
    const { lines, tiers } = groups[groupKey];

    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const tierPrice = getTierPrice(totalQty, tiers);

    for (const line of lines) {
      const basePrice = parseFloat((line.cost as any).amountPerQuantity.amount);
      const discountAmount = basePrice - tierPrice;

      if (discountAmount > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: discountAmount.toFixed(2),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message: "Tier Pricing",
        });
      }
    }
  }

  if (!candidates.length) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
