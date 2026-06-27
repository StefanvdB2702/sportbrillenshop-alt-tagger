// ============================================================
// Sportbrillenshop - Alt Tag + Bestandsnaam Updater
// Versie 8 - met uitgebreide logging voor references debug
// ============================================================

const express = require("express");
const crypto = require("crypto");
const app = express();

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

app.use(express.raw({ type: "application/json" }));

// ============================================================
// TOKEN
// ============================================================
let cachedToken = null;
let tokenVerlooptOp = null;

async function haalToken() {
  if (cachedToken && tokenVerlooptOp && new Date() < tokenVerlooptOp) return cachedToken;
  console.log("🔑 Token ophalen...");
  const res = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Token mislukt: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenVerlooptOp = new Date(Date.now() + 23 * 60 * 60 * 1000);
  console.log("✅ Token ontvangen!");
  return cachedToken;
}

// ============================================================
// HELPERS
// ============================================================
function maakNaam(titel) {
  return titel.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9\-]/g, "").replace(/-+/g, "-");
}

function isEchtShopify(body, sig) {
  if (!WEBHOOK_SECRET) return true;
  const verwacht = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig || "", "base64"), Buffer.from(verwacht, "base64"));
  } catch { return false; }
}

async function graphql(query, variables, token) {
  const res = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) console.log("⚠️ GraphQL errors:", JSON.stringify(data.errors));
  return data;
}

// ============================================================
// STAP 1: Foto's ophalen van product
// ============================================================
async function haalFotos(productId, token) {
  const data = await graphql(`
    query($id: ID!) {
      product(id: $id) {
        title
        media(first: 50) {
          edges {
            node {
              id
              mediaContentType
              ... on MediaImage {
                mimeType
                alt
              }
            }
          }
        }
      }
    }
  `, { id: productId }, token);
  return data.data?.product;
}

// ============================================================
// STAP 2: Controleer references - MET VOLLEDIGE LOGGING
// ============================================================
async function isGedeeldeFoto(mediaId, token) {
  const data = await graphql(`
    query($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          references(first: 25) {
            nodes {
              __typename
              ... on Product {
                id
                title
              }
              ... on ProductVariant {
                id
                title
                product {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  `, { id: mediaId }, token);

  const nodes = data.data?.node?.references?.nodes || [];
  
  // Log alles wat Shopify teruggeeft — zo zien we precies wat er gebeurt
  console.log(`  🔍 References ruwe data: ${JSON.stringify(nodes)}`);

  // Verzamel unieke product IDs
  const productIds = new Set();
  for (const node of nodes) {
    if (node.__typename === "Product") {
      productIds.add(node.id);
    } else if (node.__typename === "ProductVariant" && node.product?.id) {
      productIds.add(node.product.id);
    }
  }

  console.log(`  🔍 Unieke producten: ${productIds.size} → ${JSON.stringify([...productIds])}`);
  return productIds.size > 1;
}

// ============================================================
// STAP 3: Alt tag aanpassen
// ============================================================
async function pasAltAan(productId, mediaId, naam, token) {
  const data = await graphql(`
    mutation($productId: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $productId, media: $media) {
        media { id alt }
        mediaUserErrors { field message }
      }
    }
  `, { productId, media: [{ id: mediaId, alt: naam }] }, token);

  const fouten = data.data?.productUpdateMedia?.mediaUserErrors || [];
  if (fouten.length > 0) {
    console.log(`  ❌ Alt tag fout: ${fouten[0].message}`);
    return false;
  }
  console.log(`  ✅ Alt tag: "${naam}"`);
  return true;
}

// ============================================================
// STAP 4: Bestandsnaam aanpassen
// ============================================================
async function pasBestandsnaamAan(mediaId, naam, mimeType, token) {
  let ext = ".jpg";
  if (mimeType === "image/png") ext = ".png";
  else if (mimeType === "image/webp") ext = ".webp";
  else if (mimeType === "image/gif") ext = ".gif";

  const data = await graphql(`
    mutation($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files { id }
        userErrors { field message code }
      }
    }
  `, { files: [{ id: mediaId, filename: `${naam}${ext}` }] }, token);

  const fouten = data.data?.fileUpdate?.userErrors || [];
  if (fouten.length > 0) {
    console.log(`  ❌ Bestandsnaam fout: ${fouten[0].message} (${fouten[0].code})`);
    return false;
  }
  console.log(`  ✅ Bestandsnaam: "${naam}${ext}"`);
  return true;
}

// ============================================================
// HOOFDFUNCTIE
// ============================================================
async function verwerk(productData) {
  const productId = `gid://shopify/Product/${productData.id}`;
  const titel = productData.title;
  const naam = maakNaam(titel);

  console.log(`\n🛍️  Product: "${titel}" (${productId})`);
  console.log(`📝 Wordt: "${naam}"`);

  const token = await haalToken();

  // Wacht 5 seconden zodat Shopify foto's verwerkt heeft
  await new Promise(r => setTimeout(r, 5000));

  const product = await haalFotos(productId, token);
  if (!product) { console.log("❌ Product niet gevonden"); return; }

  const fotos = product.media?.edges || [];
  console.log(`📸 ${fotos.length} foto('s) gevonden`);
  if (fotos.length === 0) { console.log("ℹ️  Geen foto's"); return; }

  let gelukt = 0;
  let overgeslagen = 0;

  for (const { node: foto } of fotos) {
    if (foto.mediaContentType !== "IMAGE") continue;

    console.log(`\n  🖼️  Foto: ${foto.id}`);

    const gedeeld = await isGedeeldeFoto(foto.id, token);
    if (gedeeld) {
      console.log(`  ⏭️  Overgeslagen — gedeeld`);
      overgeslagen++;
      continue;
    }

    await pasAltAan(productId, foto.id, naam, token);
    await pasBestandsnaamAan(foto.id, naam, foto.mimeType, token);
    gelukt++;
  }

  console.log(`\n🎉 ${gelukt} bijgewerkt, ${overgeslagen} overgeslagen voor "${titel}"`);
}

// ============================================================
// WEBHOOK
// ============================================================
app.post("/webhook/product-created", async (req, res) => {
  if (!isEchtShopify(req.body, req.headers["x-shopify-hmac-sha256"])) {
    return res.status(401).send("Ongeautoriseerd");
  }
  res.status(200).send("Ontvangen!");
  try {
    await verwerk(JSON.parse(req.body.toString()));
  } catch (e) {
    console.error("❌ Fout:", e.message);
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h1>✅ Sportbrillenshop Helper v8</h1>
    <p>${SHOPIFY_SHOP_DOMAIN ? "✅" : "❌"} ${SHOPIFY_SHOP_DOMAIN || "niet ingesteld"}</p>
    <p>${SHOPIFY_CLIENT_ID ? "✅" : "❌"} Client ID</p>
    <p>${SHOPIFY_CLIENT_SECRET ? "✅" : "❌"} Client Secret</p>
    <code>${req.protocol}://${req.get("host")}/webhook/product-created</code>
  `);
});

const POORT = process.env.PORT || 3000;
app.listen(POORT, () => {
  console.log(`\n🚀 v8 gestart op poort ${POORT}`);
  console.log(`🏪 ${SHOPIFY_SHOP_DOMAIN || "❌ niet ingesteld"}`);
  console.log(`🔑 ${SHOPIFY_CLIENT_ID ? "✅" : "❌"}\n`);
});
