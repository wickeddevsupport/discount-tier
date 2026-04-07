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
const HOST = process.env.HOST || `http://localhost:${PORT}`;
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

app.listen(PORT, () => {
  console.log(`Server running on ${HOST}`);
});
