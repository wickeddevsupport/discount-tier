import crypto from "crypto";
import fetch from "node-fetch";

const CLIENT_ID = process.env.SHOPIFY_API_KEY || "ea37327871879a155fbdd95f4fc71822";
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SCOPES = "write_discounts,read_discounts";
const HOST = process.env.HOST || "";
const API_VERSION = "2026-01";

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname;

  // Home — show install form or start OAuth
  if (path === "/" || path === "/api") {
    const shop = url.searchParams.get("shop");
    if (!shop) {
      return res.send(`<h2>Tier Pricing App</h2><form method="GET" action="/api"><input name="shop" placeholder="your-store.myshopify.com" style="padding:8px;width:300px"><button type="submit" style="padding:8px 16px;margin-left:8px">Install</button></form>`);
    }
    const redirectUri = `${HOST}/api/callback`;
    const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=nonce`;
    return res.redirect(authUrl);
  }

  // OAuth callback
  if (path === "/api/callback") {
    const { shop, code } = Object.fromEntries(url.searchParams);
    if (!shop || !code) return res.status(400).send("Missing shop or code");

    // Exchange code for token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) return res.status(500).send(`Failed to get token: ${JSON.stringify(tokenData)}`);

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
    if (!fn) return res.status(500).send("Function not found. Make sure the app is deployed.");

    // Create discount
    const discountRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `mutation {
          discountAutomaticAppCreate(automaticAppDiscount: {
            title: "Tier Pricing"
            functionId: "${fn.id}"
            startsAt: "2024-01-01T00:00:00Z"
            discountClasses: [PRODUCT]
          }) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
      }),
    });
    const discountData = await discountRes.json();
    const errors = discountData?.data?.discountAutomaticAppCreate?.userErrors ?? [];
    const discount = discountData?.data?.discountAutomaticAppCreate?.automaticAppDiscount;

    if (errors.length) {
      return res.status(500).send(`<h2>❌ Error</h2><pre>${JSON.stringify(errors, null, 2)}</pre>`);
    }

    return res.send(`<h2>✅ Installed on ${shop}</h2><p>Tier Pricing discount is now active.</p><p>Discount ID: ${discount?.discountId}</p>`);
  }

  res.status(404).send("Not found");
}
