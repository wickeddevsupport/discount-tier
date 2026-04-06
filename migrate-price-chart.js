/**
 * Migration script: reads custom.price_chart metaobjects from each product
 * and creates custom.price_chart_tiers JSON metafield for the Shopify Function.
 *
 * Usage: node migrate-price-chart.js
 */

const SHOP = process.env.SHOP || "stitchreballion-ww.myshopify.com";
const TOKEN = process.env.TOKEN || "";
const API_VERSION = "2026-01";

const endpoint = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Fetch all products with their price_chart metafield (paginated)
async function fetchAllProducts() {
  const products = [];
  let cursor = null;

  while (true) {
    const data = await gql(`
      query($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            priceChart: metafield(namespace: "custom", key: "price_chart") {
              value
              type
            }
            priceChartTiers: metafield(namespace: "custom", key: "price_chart_tiers") {
              id
              value
            }
          }
        }
      }
    `, { cursor });

    const page = data?.data?.products;
    if (!page) { console.error("Error fetching products:", JSON.stringify(data)); break; }

    products.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return products;
}

// Fetch a metaobject by GID to get its fields
async function fetchMetaobject(id) {
  const data = await gql(`
    query($id: ID!) {
      metaobject(id: $id) {
        fields { key value }
      }
    }
  `, { id });
  return data?.data?.metaobject?.fields ?? [];
}

function parseNumber(str) {
  return parseFloat(String(str).replace(/[^0-9.]/g, ""));
}

async function buildTiersFromPriceChart(priceChartValue) {
  // price_chart is a list of metaobject references
  let refs;
  try {
    refs = JSON.parse(priceChartValue);
  } catch {
    return null;
  }

  // Could be array of GIDs or array of objects
  if (!Array.isArray(refs)) return null;

  const tiers = [];

  for (const ref of refs) {
    const gid = typeof ref === "string" ? ref : ref?.id ?? ref?.gid;
    if (!gid) continue;

    const fields = await fetchMetaobject(gid);
    const get = (key) => fields.find(f => f.key === key)?.value;

    const tabKey = get("tab_key");
    const qtyRaw = get("quantity_labels");
    const priceRaw = get("price_values");

    if (!tabKey || !qtyRaw || !priceRaw) {
      console.log(`  ⚠ Skipping metaobject ${gid} — missing fields`);
      continue;
    }

    let quantities, prices;
    try {
      quantities = JSON.parse(qtyRaw);
      prices = JSON.parse(priceRaw);
    } catch {
      continue;
    }

    const parsedQtys = quantities.map(q => parseInt(String(q).replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
    const parsedPrices = prices.map(p => parseNumber(p)).filter(n => !isNaN(n));

    if (!parsedQtys.length || !parsedPrices.length) continue;

    tiers.push({
      tab_key: String(tabKey).toLowerCase().trim(),
      quantities: parsedQtys,
      prices: parsedPrices,
    });
  }

  return tiers.length ? tiers : null;
}

async function setMetafield(productId, value) {
  const data = await gql(`
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: productId,
      metafields: [{
        namespace: "custom",
        key: "price_chart_tiers",
        type: "json",
        value: JSON.stringify(value),
      }],
    },
  });

  const errors = data?.data?.productUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(JSON.stringify(errors));
}

async function main() {
  console.log("Fetching products...");
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products\n`);

  let migrated = 0, skipped = 0, failed = 0;

  for (const product of products) {
    const title = product.title;

    if (!product.priceChart?.value) {
      console.log(`⏭ SKIP  ${title} — no price_chart metafield`);
      skipped++;
      continue;
    }

    if (product.priceChartTiers?.value) {
      console.log(`⏭ SKIP  ${title} — price_chart_tiers already exists`);
      skipped++;
      continue;
    }

    console.log(`⚙ Processing ${title}...`);

    try {
      const tiers = await buildTiersFromPriceChart(product.priceChart.value);
      if (!tiers) {
        console.log(`  ⚠ Could not parse tiers for ${title}`);
        failed++;
        continue;
      }

      await setMetafield(product.id, tiers);
      console.log(`  ✅ Set price_chart_tiers: ${tiers.map(t => t.tab_key).join(", ")}`);
      migrated++;
    } catch (err) {
      console.log(`  ❌ Failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}, Failed: ${failed}`);
}

main();
