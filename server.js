// ============================================================
// Sportbrillenshop - Alt Tag + Bestandsnaam Updater
// Versie 9 - alleen foto's zonder alt tag worden aangepast
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
// STAP 1: Foto's ophalen van product inclusief alt tag
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
              alt
              ... on MediaImage {
                mimeType
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
// STAP 2: Alt tag aanpassen
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
// STAP 3: Bestandsnaam aanpassen
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

  console.log(`\n🛍️  Product: "${titel}"`);
  console.log(`📝 Wordt: "${naam}"`);

  const token = await haalToken();

  // Wacht 3 seconden zodat Shopify foto's verwerkt heeft
  await new Promise(r => setTimeout(r, 3000));

  const product = await haalFotos(productId, token);
  if (!product) { console.log("❌ Product niet gevonden"); return; }

  const fotos = product.media?.edges || [];
  console.log(`📸 ${fotos.length} foto('s) gevonden`);
  if (fotos.length === 0) { console.log("ℹ️  Geen foto's — wordt opgepakt zodra foto's worden toegevoegd"); return; }

  let gelukt = 0;
  let overgeslagen = 0;

  for (const { node: foto } of fotos) {
    if (foto.mediaContentType !== "IMAGE") continue;

    console.log(`\n  🖼️  Foto: ${foto.id}`);
    console.log(`  📌 Huidige alt tag: "${foto.alt || "(leeg)"}"`);

    // ============================================================
    // SLIMME CHECK: alleen foto's zonder alt tag worden aangepast
    // Als een foto al een alt tag heeft → is hij al eerder verwerkt
    // of wordt hij door meerdere producten gebruikt → overslaan!
    // ============================================================
    if (foto.alt && foto.alt.trim() !== "") {
      console.log(`  ⏭️  Overgeslagen — heeft al een alt tag`);
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
// WEBHOOKS
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

app.post("/webhook/product-updated", async (req, res) => {
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
    <h1>✅ Sportbrillenshop Helper v9</h1>
    <p>${SHOPIFY_SHOP_DOMAIN ? "✅" : "❌"} ${SHOPIFY_SHOP_DOMAIN || "niet ingesteld"}</p>
    <p>${SHOPIFY_CLIENT_ID ? "✅" : "❌"} Client ID</p>
    <p>${SHOPIFY_CLIENT_SECRET ? "✅" : "❌"} Client Secret</p>
    <h2>Webhook URLs:</h2>
    <p><code>${req.protocol}://${req.get("host")}/webhook/product-created</code></p>
    <p><code>${req.protocol}://${req.get("host")}/webhook/product-updated</code></p>
  `);
});

const POORT = process.env.PORT || 3000;
app.listen(POORT, () => {
  console.log(`\n🚀 v9 gestart op poort ${POORT}`);
  console.log(`🏪 ${SHOPIFY_SHOP_DOMAIN || "❌ niet ingesteld"}`);
  console.log(`🔑 ${SHOPIFY_CLIENT_ID ? "✅" : "❌"}\n`);
});
