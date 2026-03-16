import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.SHOPIFY_API_KEY || "ea37327871879a155fbdd95f4fc71822";
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SCOPES = "write_discounts,read_discounts";
const API_VERSION = "2026-01";

// In-memory token store (use a DB for production)
const tokenStore = {};

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", CLIENT_SECRET).update(message).digest("hex");
  return digest === hmac;
}

// Step 1: Start OAuth
app.get("/", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send(`<h2>Tier Pricing App</h2><form method="GET"><input name="shop" placeholder="your-store.myshopify.com" style="padding:8px;width:300px"><button type="submit" style="padding:8px 16px;margin-left:8px">Install</button></form>`);

  const redirectUri = `${HOST}/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=nonce`;
  res.redirect(authUrl);
});

// Step 2: OAuth callback — get token + create discount
app.get("/callback", async (req, res) => {
  const { shop, code, hmac } = req.query;

  if (!shop || !code) return res.status(400).send("Missing shop or code");

  // Exchange code for token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  if (!token) {
    return res.status(500).send(`Failed to get token: ${JSON.stringify(tokenData)}`);
  }

  tokenStore[shop] = token;
  console.log(`✅ Token obtained for ${shop}`);

  // Get function ID
  const fnRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: `{ shopifyFunctions(first: 20) { nodes { id title apiType } } }` }),
  });
  const fnData = await fnRes.json();
  const fn = (fnData?.data?.shopifyFunctions?.nodes ?? []).find(
    f => f.title?.toLowerCase().includes("tier") || f.apiType === "discount"
  );

  if (!fn) {
    return res.status(500).send("Function not found. Make sure the app is deployed.");
  }

  console.log(`✅ Found function: ${fn.title} → ${fn.id}`);

  // Create the automatic discount
  const discountRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      query: `
        mutation {
          discountAutomaticAppCreate(
            automaticAppDiscount: {
              title: "Tier Pricing"
              functionId: "${fn.id}"
              startsAt: "2024-01-01T00:00:00Z"
              discountClasses: [PRODUCT]
            }
          ) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }
      `,
    }),
  });

  const discountData = await discountRes.json();
  const errors = discountData?.data?.discountAutomaticAppCreate?.userErrors ?? [];
  const discount = discountData?.data?.discountAutomaticAppCreate?.automaticAppDiscount;

  if (errors.length) {
    // Discount might already exist — that's fine
    if (errors[0]?.message?.toLowerCase().includes("already")) {
      return res.send(`<h2>✅ App installed on ${shop}</h2><p>Tier Pricing discount already exists.</p>`);
    }
    return res.status(500).send(`<h2>❌ Error creating discount</h2><pre>${JSON.stringify(errors, null, 2)}</pre>`);
  }

  console.log(`✅ Discount created: ${discount?.discountId}`);
  res.send(`<h2>✅ App installed successfully on ${shop}</h2><p>Tier Pricing automatic discount is now active.</p><p>Discount ID: ${discount?.discountId}</p>`);
});

app.listen(PORT, () => {
  console.log(`Server running on ${HOST}`);
  console.log(`Install URL: ${HOST}/?shop=your-store.myshopify.com`);
});
