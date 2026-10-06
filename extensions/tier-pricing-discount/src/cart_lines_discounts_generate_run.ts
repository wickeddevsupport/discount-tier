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

type PromoCode = {
  code: string;
  discountLevel: string;
  type: string;
  value: number;
  appliesTo: string;
  productIds: string[];
  collectionIds: string[];
  expires: string;
};

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
  for (const tier of tiers) {
    if (qty >= tier.qty) price = tier.price;
  }
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

function parsePromoCodes(raw: string | null | undefined): PromoCode[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const today = new Date().toISOString().slice(0, 10);
    return parsed.filter((item: any) => {
      if (!item || !item.code || !item.type || item.value == null) return false;
      if (item.expires && String(item.expires) < today) return false;
      return true;
    }).map((item: any) => ({
      code: String(item.code).toUpperCase().trim(),
      discountLevel: String(item.discountLevel ?? "product"),
      type: String(item.type),
      value: parseFloat(item.value),
      appliesTo: String(item.appliesTo ?? "all"),
      productIds: Array.isArray(item.productIds) ? item.productIds.map(String) : [],
      collectionIds: Array.isArray(item.collectionIds) ? item.collectionIds.map(String) : [],
      expires: String(item.expires ?? ""),
    }));
  } catch { return []; }
}

function findActivePromo(promoCodes: PromoCode[], enteredCodes: any[]): PromoCode | null {
  if (!enteredCodes || !enteredCodes.length) return null;
  for (const entered of enteredCodes) {
    const code = String(entered?.code ?? "").toUpperCase().trim();
    const match = promoCodes.find(p => p.code === code);
    if (match) return match;
  }
  return null;
}

function promoAppliesToProduct(promo: PromoCode, productGid: string): boolean {
  if (promo.appliesTo === "all") return true;
  if (promo.appliesTo === "products") {
    return promo.productIds.indexOf(productGid) !== -1;
  }
  // collections: handled via collectionIds — without inCollection query support,
  // we skip collection filtering at runtime (all products match)
  if (promo.appliesTo === "collections") return true;
  return true;
}

export function cartLinesDiscountsGenerateRun(input: Input): CartLinesDiscountsGenerateRunResult {

  // ── 0. Resolve active promo ────────────────────────────────────────────────
  const promoRaw = (input as any)?.shop?.promoCodes?.value ?? null;
  const promoCodes = parsePromoCodes(promoRaw);
  const enteredCodes = (input as any)?.enteredDiscountCodes ?? [];
  const activePromo = findActivePromo(promoCodes, enteredCodes);

  // ── 1. Group hat lines by (bundleId + patchType) ───────────────────────────
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
      if (!tiers || !tiers.length) continue;
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
      const productGid: string = (line.merchandise as any)?.product?.id ?? "";

      let effectivePrice = tierPrice;
      let promoApplied = false;

      if (activePromo && activePromo.discountLevel === "product" && promoAppliesToProduct(activePromo, productGid)) {
        promoApplied = true;
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = tierPrice - activePromo.value;
          if (effectivePrice < 0) effectivePrice = 0;
        }
      }

      const discountAmount = basePrice - effectivePrice;
      if (discountAmount > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: String(discountAmount.toFixed(2)),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message: promoApplied ? ("Tier Pricing + " + activePromo!.code) : "Tier Pricing",
        });
      }
    }
  }

  // ── 3. Addon lines ─────────────────────────────────────────────────────────
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
      const productGid: string = (line.merchandise as any)?.product?.id ?? "";

      let effectivePrice = tierPrice;
      let promoApplied = false;

      if (activePromo && activePromo.discountLevel === "product" && promoAppliesToProduct(activePromo, productGid)) {
        promoApplied = true;
        if (activePromo.type === "percentage") {
          effectivePrice = tierPrice * (1 - activePromo.value / 100);
        } else {
          effectivePrice = tierPrice - activePromo.value;
          if (effectivePrice < 0) effectivePrice = 0;
        }
      }

      const discountAmount = basePrice - effectivePrice;
      if (discountAmount > 0) {
        candidates.push({
          targets: [{ cartLine: { id: line.id } }],
          value: {
            fixedAmount: {
              amount: String(discountAmount.toFixed(2)),
              appliesToEachItem: true,
            } satisfies ProductDiscountCandidateFixedAmount,
          },
          message: promoApplied ? ("Tier Pricing + " + activePromo!.code) : "Tier Pricing",
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

  // ── 4. Order-level promo ───────────────────────────────────────────────────
  if (activePromo && activePromo.discountLevel === "order") {
    // Calculate post-tier subtotal
    let subtotal = 0;
    for (const groupKey in groups) {
      const { lines, tiers } = groups[groupKey];
      const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
      const tierPrice = getTierPrice(totalQty, tiers);
      for (const line of lines) {
        subtotal += tierPrice * line.quantity;
      }
    }
    for (const key in addonGroups) {
      const lines = addonGroups[key];
      const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
      const tierPrice = getTierPrice(totalQty, ADDON_TIERS);
      for (const line of lines) {
        subtotal += tierPrice * line.quantity;
      }
    }

    let orderDiscountAmount = 0;
    if (activePromo.type === "percentage") {
      orderDiscountAmount = subtotal * (activePromo.value / 100);
    } else {
      orderDiscountAmount = activePromo.value;
      if (orderDiscountAmount > subtotal) orderDiscountAmount = subtotal;
    }

    if (orderDiscountAmount > 0) {
      operations.push({
        orderDiscountsAdd: {
          candidates: [
            {
              message: activePromo.code,
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: {
                fixedAmount: {
                  amount: String(orderDiscountAmount.toFixed(2)),
                },
              },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      });
    }
  }

  // ── 5. Accept promo code ───────────────────────────────────────────────────
  if (activePromo) {
    operations.push({
      enteredDiscountCodesAccept: {
        codes: [{ code: activePromo.code }],
      },
    });
  }

  return { operations };
}
