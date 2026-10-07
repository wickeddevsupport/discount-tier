import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "https://tier-pricing-discount-production-2f08.up.railway.app";
const CLIENT_ID = process.env.SHOPIFY_API_KEY || "ea37327071079a155fbdd95f4fc71022";
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SCOPES = "write_discounts,read_discounts,read_products,write_products,read_metaobjects";
const API_VERSION = "2026-01";

// In-memory token store (use a DB for production)
const tokenStore = {};

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", CLIENT_SECRET).update(message).digest("hex");
  return digest === hmac;
}

function gql(shop, token, query, variables = {}) {
  return fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  }).then(r => r.json());
}

// ── OAuth ──────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.send(`<h2>Tier Pricing App</h2><form method="GET"><input name="shop" placeholder="your-store.myshopify.com" style="padding:8px;width:300px"><button type="submit" style="padding:8px 16px;margin-left:8px">Install</button></form>`);
  }
  const redirectUri = `${HOST}/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=nonce`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send("Missing shop or code");

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });
  const tokenText = await tokenRes.text();
  let tokenData;
  try { tokenData = JSON.parse(tokenText); } catch {
    return res.status(500).send(`Token exchange failed: ${tokenText.substring(0, 500)}`);
  }
  const token = tokenData.access_token;
  if (!token) return res.status(500).send(`Failed to get token: ${JSON.stringify(tokenData)}`);

  tokenStore[shop] = token;

  // Get function ID and create discount if not exists
  const fnData = await gql(shop, token, `{ shopifyFunctions(first: 20) { nodes { id title apiType } } }`);
  const fn = (fnData?.data?.shopifyFunctions?.nodes ?? []).find(
    f => f.title?.toLowerCase().includes("tier") || f.apiType === "discount"
  );

  if (fn) {
    const discountData = await gql(shop, token, `
      mutation {
        discountAutomaticAppCreate(automaticAppDiscount: {
          title: "Tier Pricing"
          functionId: "${fn.id}"
          startsAt: "2024-01-01T00:00:00Z"
          discountClasses: [PRODUCT]
          combinesWith: {
            orderDiscounts: true
            productDiscounts: true
            shippingDiscounts: true
          }
        }) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }
    `);
    const errors = discountData?.data?.discountAutomaticAppCreate?.userErrors ?? [];
    console.log(errors.length ? `Discount note: ${errors[0].message}` : `✅ Discount created`);
  }

  res.redirect(`/admin?shop=${shop}`);
});

// ── Admin UI ───────────────────────────────────────────────────────────────

app.get("/admin", (req, res) => {
  res.send(readFileSync(join(__dirname, "views/admin.html"), "utf8"));
});

app.get("/admin/product/:id", (req, res) => {
  res.send(readFileSync(join(__dirname, "views/product.html"), "utf8"));
});

// ── API: product list ──────────────────────────────────────────────────────

app.get("/api/products", async (req, res) => {
  const { shop, after, query } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });

  const searchFilter = query ? `, query: "${query}"` : "";
  const afterCursor = after ? `, after: "${after}"` : "";

  const data = await gql(shop, token, `{
    products(first: 20${searchFilter}${afterCursor}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        featuredImage { url }
        variants(first: 1) { nodes { id } }
        priceChart: metafield(namespace: "custom", key: "price_chart_tiers") { value }
      }
    }
  }`);

  const nodes = data?.data?.products?.nodes ?? [];
  const pageInfo = data?.data?.products?.pageInfo ?? {};

  res.json({
    products: nodes.map(p => ({
      id: p.id.split("/").pop(),
      title: p.title,
      image: p.featuredImage?.url ?? null,
      variantCount: p.variants?.nodes?.length ?? 0,
      hasTiers: !!p.priceChart?.value,
    })),
    hasNextPage: pageInfo.hasNextPage ?? false,
    endCursor: pageInfo.endCursor ?? null,
  });
});

// ── API: get product tiers ─────────────────────────────────────────────────

app.get("/api/product/:id/tiers", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });

  const gid = `gid://shopify/Product/${req.params.id}`;
  const data = await gql(shop, token, `{
    product(id: "${gid}") {
      id title
      featuredImage { url }
      variants(first: 1) { nodes { id } }
      priceChart: metafield(namespace: "custom", key: "price_chart_tiers") { value }
    }
  }`);

  const product = data?.data?.product;
  if (!product) return res.status(404).json({ error: "Product not found" });

  // Parse existing tiers into { embroidery: Tier[], vegan-leather: Tier[] }
  let parsedTiers = null;
  if (product.priceChart?.value) {
    try {
      const raw = JSON.parse(product.priceChart.value);
      const charts = Array.isArray(raw) ? raw : [raw];
      parsedTiers = {};
      for (const chart of charts) {
      const rawKey = String(chart?.tab_key?.value ?? chart?.tab_key ?? "")
        .toLowerCase().trim().replace(/[\s_]+/g, "-");
      // Normalise "vegan" → "vegan-leather" to match UI key
      const key = rawKey === "vegan" ? "vegan-leather" : rawKey;
        const qtys = chart?.quantities ?? chart?.quantity_labels?.value ?? chart?.quantity_labels ?? [];
        const prices = chart?.prices ?? chart?.price_values?.value ?? chart?.price_values ?? [];
        if (!key || !qtys.length) continue;
        parsedTiers[key] = qtys.map((q, i) => ({
          qty: parseInt(String(q).replace(/\D/g, ""), 10),
          price: parseFloat(String(prices[i] ?? 0).replace(/[^0-9.]/g, "")),
        })).filter(t => !isNaN(t.qty) && !isNaN(t.price));
      }
    } catch { parsedTiers = null; }
  }

  res.json({
    id: product.id.split("/").pop(),
    title: product.title,
    image: product.featuredImage?.url ?? null,
    variantCount: product.variants?.nodes?.length ?? 0,
    tiers: parsedTiers,
  });
});

// ── API: save product tiers ────────────────────────────────────────────────

app.post("/api/product/:id/tiers", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });

  const payload = req.body; // { embroidery: [{qty, price}], "vegan-leather": [{qty, price}] }

  // Build the JSON array in Shape A format the function already reads
  const charts = Object.entries(payload)
    .filter(([, tiers]) => tiers.length > 0)
    .map(([key, tiers]) => ({
      tab_key: key,
      quantities: tiers.map(t => t.qty),
      prices: tiers.map(t => t.price),
    }));

  const gid = `gid://shopify/Product/${req.params.id}`;

  // Upsert the metafield
  const data = await gql(shop, token, `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: gid,
      metafields: [{
        namespace: "custom",
        key: "price_chart_tiers",
        type: "json",
        value: JSON.stringify(charts),
      }],
    },
  });

  const errors = data?.data?.productUpdate?.userErrors ?? [];
  if (errors.length) return res.json({ ok: false, error: errors[0].message });

  res.json({ ok: true });
});

// Finds this app's automatic discount(s) (Tier Pricing) by app key, not by title.
async function findTierAutomaticDiscounts(shop, token) {
  const found = [];
  const seen = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const data = await gql(shop, token, `
      query($after: String) {
        automaticDiscountNodes(first: 100, after: $after) {
          nodes {
            id
            automaticDiscount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
                discountClasses
                combinesWith { productDiscounts orderDiscounts shippingDiscounts }
                appDiscountType { appKey functionId title }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after });
    if (data?.errors) return { found, seen, errors: data.errors };
    const conn = data?.data?.automaticDiscountNodes;
    for (const n of conn?.nodes ?? []) {
      const d = n.automaticDiscount;
      if (d?.__typename !== "DiscountAutomaticApp") continue;
      seen.push({ id: n.id, title: d.title, status: d.status, appKey: d.appDiscountType?.appKey });
      if (d.appDiscountType?.appKey === CLIENT_ID) found.push({ id: n.id, ...d });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { found, seen, errors: null };
}

// Read-only: shows this app's discounts so we can check setup without the Shopify admin.
app.get("/api/debug/discounts", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const auto = await findTierAutomaticDiscounts(shop, token);
  const { codes } = await readPromoMetafield(shop, token);
  const promoInShopify = [];
  for (const c of codes) {
    const node = await findCodeDiscount(shop, token, String(c.code).toUpperCase().trim());
    promoInShopify.push({ code: c.code, existsInShopify: !!node, createdByThisApp: isOurPromoDiscount(node) });
  }
  res.json({ tierAutomaticDiscounts: auto.found, otherAppAutomaticDiscounts: auto.seen.filter(s => s.appKey !== CLIENT_ID), errors: auto.errors, promoCodes: promoInShopify });
});

// ── One-time fix: let the Tier Pricing discount combine with promo codes ──────

app.get("/api/fix-discount-combinations", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  const { found, seen, errors: listErrors } = await findTierAutomaticDiscounts(shop, token);
  if (listErrors) return res.json({ ok: false, error: listErrors[0]?.message ?? "Could not list discounts" });
  if (!found.length) return res.json({ ok: false, error: "Tier Pricing discount not found", automaticAppDiscountsSeen: seen });

  const results = [];
  for (const d of found) {
    const updateData = await gql(shop, token, `
      mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { title combinesWith { productDiscounts orderDiscounts shippingDiscounts } }
          userErrors { field message }
        }
      }
    `, {
      id: d.id,
      automaticAppDiscount: {
        combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      },
    });
    const errs = updateData?.data?.discountAutomaticAppUpdate?.userErrors ?? updateData?.errors ?? [];
    results.push(errs.length
      ? { title: d.title, ok: false, error: errs[0].message }
      : { title: d.title, ok: true, combinesWith: updateData.data.discountAutomaticAppUpdate.automaticAppDiscount.combinesWith });
  }
  res.json({ ok: results.every(r => r.ok), results });
});

app.get("/api/promo-codes", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });

  const data = await gql(shop, token, `{
    shop {
      metafield(namespace: "custom", key: "promo_codes") {
        value
      }
    }
  }`);

  const raw = data?.data?.shop?.metafield?.value;
  let codes = [];
  if (raw) {
    try { codes = JSON.parse(raw); } catch { codes = []; }
  }
  res.json({ codes });
});

// ── Promo codes → real Shopify code discounts ─────────────────────────────
//
// Shopify only lets a discount function see codes that exist in Shopify, so
// every promo code is also created as a code discount backed by our function.
// Its settings live in the discount's `tier_pricing.promo` metafield, and the
// function applies the promo on top of the tier price.

const PROMO_TITLE_PREFIX = "Promo code (Tier Pricing): ";
const FUNCTION_HANDLE = "tier-pricing-discount"; // handle in extensions/tier-pricing-discount/shopify.extension.toml

async function findCodeDiscount(shop, token, code) {
  const data = await gql(shop, token, `
    query($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount { __typename ... on DiscountCodeApp { title } }
      }
    }
  `, { code });
  return data?.data?.codeDiscountNodeByCode ?? null;
}

function isOurPromoDiscount(node) {
  return node?.codeDiscount?.__typename === "DiscountCodeApp" &&
    String(node.codeDiscount.title ?? "").startsWith(PROMO_TITLE_PREFIX);
}

async function resolveCollectionProductIds(shop, token, collectionIds) {
  const ids = [];
  for (const collectionId of collectionIds) {
    let after = null;
    for (let page = 0; page < 20; page++) {
      const data = await gql(shop, token, `
        query($id: ID!, $after: String) {
          collection(id: $id) {
            products(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
          }
        }
      `, { id: collectionId, after });
      const products = data?.data?.collection?.products;
      if (!products) break;
      for (const p of products.nodes) if (!ids.includes(p.id)) ids.push(p.id);
      if (!products.pageInfo.hasNextPage) break;
      after = products.pageInfo.endCursor;
    }
  }
  return ids;
}

async function syncOnePromo(shop, token, promo) {
  const code = String(promo.code).toUpperCase().trim();
  const isOrder = promo.discountLevel === "order";

  // Settings the function reads. Collections are resolved to product IDs here.
  let productIds = Array.isArray(promo.productIds) ? promo.productIds : [];
  if (!isOrder && promo.appliesTo === "collections") {
    productIds = await resolveCollectionProductIds(shop, token, promo.collectionIds ?? []);
  }
  const config = {
    code,
    discountLevel: isOrder ? "order" : "product",
    type: promo.type,
    value: promo.value,
    appliesTo: isOrder ? "all" : (promo.appliesTo ?? "all"),
    productIds,
    expires: promo.expires ?? "",
  };

  const discountInput = {
    title: PROMO_TITLE_PREFIX + code,
    discountClasses: [isOrder ? "ORDER" : "PRODUCT"],
    // Must combine with product discounts so it stacks with the Tier Pricing automatic discount.
    combinesWith: { productDiscounts: true, orderDiscounts: !isOrder, shippingDiscounts: true },
    endsAt: promo.expires ? `${promo.expires}T23:59:59Z` : null,
  };
  const configMetafield = { namespace: "tier_pricing", key: "promo", type: "json", value: JSON.stringify(config) };

  const existing = await findCodeDiscount(shop, token, code);

  if (existing && !isOurPromoDiscount(existing)) {
    return `${code}: this code is already used by another discount in Shopify. Delete or rename that one first.`;
  }

  if (existing) {
    const data = await gql(shop, token, `
      mutation($id: ID!, $d: DiscountCodeAppInput!) {
        discountCodeAppUpdate(id: $id, codeAppDiscount: $d) { userErrors { field message } }
      }
    `, { id: existing.id, d: discountInput });
    const errs = data?.data?.discountCodeAppUpdate?.userErrors ?? data?.errors ?? [];
    if (errs.length) return `${code}: ${errs[0].message}`;

    const mf = await gql(shop, token, `
      mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }
    `, { m: [{ ownerId: existing.id, ...configMetafield }] });
    const mfErrs = mf?.data?.metafieldsSet?.userErrors ?? mf?.errors ?? [];
    return mfErrs.length ? `${code}: ${mfErrs[0].message}` : null;
  }

  const data = await gql(shop, token, `
    mutation($d: DiscountCodeAppInput!) {
      discountCodeAppCreate(codeAppDiscount: $d) {
        codeAppDiscount { discountId }
        userErrors { field message }
      }
    }
  `, {
    d: {
      ...discountInput,
      functionHandle: FUNCTION_HANDLE,
      code,
      startsAt: new Date().toISOString(),
      context: { all: "ALL" },
      metafields: [configMetafield],
    },
  });
  const errs = data?.data?.discountCodeAppCreate?.userErrors ?? data?.errors ?? [];
  return errs.length ? `${code}: ${errs[0].message}` : null;
}

async function deletePromoDiscount(shop, token, code) {
  const existing = await findCodeDiscount(shop, token, String(code).toUpperCase().trim());
  if (!existing || !isOurPromoDiscount(existing)) return null; // never touch discounts we didn't create
  const data = await gql(shop, token, `
    mutation($id: ID!) { discountCodeDelete(id: $id) { userErrors { field message } } }
  `, { id: existing.id });
  const errs = data?.data?.discountCodeDelete?.userErrors ?? data?.errors ?? [];
  return errs.length ? `${code}: ${errs[0].message}` : null;
}

async function syncPromoCodes(shop, token, codes, previousCodes = []) {
  const errors = [];
  for (const promo of codes) {
    const err = await syncOnePromo(shop, token, promo);
    if (err) errors.push(err);
  }
  const keep = codes.map(c => String(c.code).toUpperCase().trim());
  for (const old of previousCodes) {
    const oldCode = String(old.code).toUpperCase().trim();
    if (keep.includes(oldCode)) continue;
    const err = await deletePromoDiscount(shop, token, oldCode);
    if (err) errors.push(err);
  }
  return errors;
}

async function readPromoMetafield(shop, token) {
  const data = await gql(shop, token, `{ shop { id metafield(namespace: "custom", key: "promo_codes") { value } } }`);
  let codes = [];
  try { codes = JSON.parse(data?.data?.shop?.metafield?.value ?? "[]"); } catch { codes = []; }
  return { shopId: data?.data?.shop?.id, codes: Array.isArray(codes) ? codes : [] };
}

// ── API: save promo codes (full replace) ──────────────────────────────────

app.post("/api/promo-codes", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });

  const { codes } = req.body; // array of PromoCode objects
  if (!Array.isArray(codes)) return res.status(400).json({ error: "codes must be an array" });

  const { shopId, codes: previousCodes } = await readPromoMetafield(shop, token);
  if (!shopId) return res.status(500).json({ error: "Could not get shop ID" });

  // 1. Create / update / delete the real Shopify code discounts
  const syncErrors = await syncPromoCodes(shop, token, codes, previousCodes);
  if (syncErrors.length) {
    console.log("Promo sync errors:", syncErrors);
    return res.json({ ok: false, error: syncErrors.join(" | ") });
  }

  // 2. Save the list for the admin UI
  const data = await gql(shop, token, `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: shopId,
      namespace: "custom",
      key: "promo_codes",
      type: "json",
      value: JSON.stringify(codes),
    }],
  });

  const errors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) return res.json({ ok: false, error: errors[0].message });
  res.json({ ok: true });
});

// ── One-time: create Shopify code discounts for promo codes saved before this fix ──

app.get("/api/promo-codes/sync", async (req, res) => {
  const { shop } = req.query;
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: "Not authenticated. Please reinstall the app." });
  const { codes } = await readPromoMetafield(shop, token);
  const errors = await syncPromoCodes(shop, token, codes, []);
  res.json({ ok: errors.length === 0, synced: codes.map(c => c.code), errors });
});

app.listen(PORT, () => {
  console.log(`Server running on ${HOST}`);
});
