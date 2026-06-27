// ============================================================
// Sportbrillenshop - Automatische Alt Tag + Bestandsnaam Updater
// Versie 6 - gedeelde foto's correct overslaan via references
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
// TOEGANGSTOKEN OPHALEN
// ============================================================
let cachedToken = null;
let tokenVerlooptOp = null;

async function haalToegangstokenOp() {
  if (cachedToken && tokenVerlooptOp && new Date() < tokenVerlooptOp) {
    return cachedToken;
  }
  console.log("🔑 Nieuw toegangstoken ophalen bij Shopify...");
  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    }
  );
  if (!response.ok) {
    const fout = await response.text();
    throw new Error(`Token ophalen mislukt: ${fout}`);
  }
  const data = await response.json();
  cachedToken = data.access_token;
  tokenVerlooptOp = new Date(Date.now() + 23 * 60 * 60 * 1000);
  console.log("✅ Nieuw toegangstoken ontvangen!");
  return cachedToken;
}

// ============================================================
// HELPER: Maakt een mooie naam van de producttitel
// ============================================================
function maakNaam(producttitel) {
  return producttitel
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9\-]/g, "")
    .replace(/-+/g, "-");
}

// ============================================================
// CONTROLEER OF HET BERICHT ECHT VAN SHOPIFY KOMT
// ============================================================
function isEchtShopifyBericht(body, handtekening) {
  if (!WEBHOOK_SECRET) return true;
  const verwachteHandtekening = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(handtekening || "", "base64"),
      Buffer.from(verwachteHandtekening, "base64")
    );
  } catch {
    return false;
  }
}

// ============================================================
// GRAPHQL HULPFUNCTIE
// ============================================================
async function shopifyGraphQL(query, variables, token) {
  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return response.json();
}

// ============================================================
// STAP 1: Haal alle foto's op van een product
// ============================================================
async function haalFotosOp(productId, token) {
  const data = await shopifyGraphQL(`
    query getProductMedia($id: ID!) {
      product(id: $id) {
        title
        media(first: 50) {
          edges {
            node {
              id
              alt
              mediaContentType
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
// STAP 2: Vraag aan Shopify hoeveel producten deze foto gebruiken
// Geeft TRUE terug als de foto door meerdere producten wordt gebruikt
// ============================================================
async function wordtDoorMeerdereProductenGebruikt(mediaId, huidigProductId, token) {
  const data = await shopifyGraphQL(`
    query checkReferences($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          references(first: 10) {
            edges {
              node {
                ... on Product {
                  id
                }
              }
            }
          }
        }
      }
    }
  `, { id: mediaId }, token);

  const edges = data.data?.node?.references?.edges || [];

  // Filter alleen echte product-referenties
  const productIds = edges
    .map(e => e.node?.id)
    .filter(id => id && id.includes("gid://shopify/Product/"));

  console.log(`  🔍 Foto gebruikt door ${productIds.length} product(en): ${productIds.join(", ")}`);

  // Als meer dan 1 product → overslaan
  return productIds.length > 1;
}

// ============================================================
// STAP 3: Pas alt tag aan
// ============================================================
async function pasAltTagAan(productId, mediaId, nieuweAltTag, token) {
  const data = await shopifyGraphQL(`
    mutation updateMediaAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $productId, media: $media) {
        media { id alt }
        mediaUserErrors { field message }
      }
    }
  `, {
    productId,
    media: [{ id: mediaId, alt: nieuweAltTag }],
  }, token);
  return data.data?.productUpdateMedia;
}

// ============================================================
// STAP 4: Pas bestandsnaam aan (vereist write_files scope!)
// ============================================================
async function pasBestandsnaamAan(mediaId, nieuweNaam, mimeType, token) {
  let extensie = ".jpg";
  if (mimeType === "image/png") extensie = ".png";
  else if (mimeType === "image/webp") extensie = ".webp";
  else if (mimeType === "image/gif") extensie = ".gif";

  const data = await shopifyGraphQL(`
    mutation fileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files { id }
        userErrors { field message code }
      }
    }
  `, {
    files: [{ id: mediaId, filename: `${nieuweNaam}${extensie}` }],
  }, token);
  return data.data?.fileUpdate;
}

// ============================================================
// HOOFDFUNCTIE
// ============================================================
async function verwerkNieuwProduct(productData) {
  const shopifyProductId = `gid://shopify/Product/${productData.id}`;
  const producttitel = productData.title;
  const nieuweNaam = maakNaam(producttitel);

  console.log(`\n🛍️  Product: "${producttitel}"`);
  console.log(`📝 Nieuwe naam wordt: "${nieuweNaam}"`);

  const token = await haalToegangstokenOp();

  // Wacht even zodat Shopify de foto's klaar heeft
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const product = await haalFotosOp(shopifyProductId, token);

  if (!product) {
    console.log("❌ Product niet gevonden");
    return;
  }

  const fotos = product.media?.edges || [];
  console.log(`📸 Aantal foto's: ${fotos.length}`);

  if (fotos.length === 0) {
    console.log("ℹ️  Geen foto's bij dit product");
    return;
  }

  let aantalGelukt = 0;
  let aantalOvergeslagen = 0;

  for (const { node: foto } of fotos) {
    if (foto.mediaContentType !== "IMAGE") continue;

    // Vraag aan Shopify of deze foto door meerdere producten wordt gebruikt
    const gedeeld = await wordtDoorMeerdereProductenGebruikt(foto.id, shopifyProductId, token);

    if (gedeeld) {
      console.log(`  ⏭️  Foto overgeslagen — gedeeld met andere producten`);
      aantalOvergeslagen++;
      continue;
    }

    console.log(`\n  🖼️  Foto verwerken...`);

    // Alt tag aanpassen
    const altResultaat = await pasAltTagAan(shopifyProductId, foto.id, nieuweNaam, token);
    if (altResultaat?.mediaUserErrors?.length > 0) {
      console.log(`  ❌ Alt tag fout: ${altResultaat.mediaUserErrors[0].message}`);
    } else {
      console.log(`  ✅ Alt tag: "${nieuweNaam}"`);
    }

    // Bestandsnaam aanpassen
    const bestandsResultaat = await pasBestandsnaamAan(foto.id, nieuweNaam, foto.mimeType, token);
    if (bestandsResultaat?.userErrors?.length > 0) {
      console.log(`  ❌ Bestandsnaam fout: ${bestandsResultaat.userErrors[0].message}`);
      console.log(`  ℹ️  Controleer of write_files is toegevoegd aan de app-rechten`);
    } else {
      const ext = foto.mimeType === "image/png" ? ".png" : foto.mimeType === "image/webp" ? ".webp" : ".jpg";
      console.log(`  ✅ Bestandsnaam: "${nieuweNaam}${ext}"`);
      aantalGelukt++;
    }
  }

  console.log(`\n🎉 Klaar! ${aantalGelukt} foto('s) bijgewerkt, ${aantalOvergeslagen} overgeslagen voor "${producttitel}"`);
}

// ============================================================
// WEBHOOKS
// ============================================================
app.post("/webhook/product-created", async (req, res) => {
  const handtekening = req.headers["x-shopify-hmac-sha256"];
  if (!isEchtShopifyBericht(req.body, handtekening)) {
    console.log("⚠️  Ongeldig bericht — genegeerd");
    return res.status(401).send("Ongeautoriseerd");
  }
  res.status(200).send("Ontvangen!");
  try {
    const productData = JSON.parse(req.body.toString());
    await verwerkNieuwProduct(productData);
  } catch (fout) {
    console.error("❌ Fout:", fout.message);
  }
});

// Test-pagina
app.get("/", (req, res) => {
  res.send(`
    <h1>✅ Sportbrillenshop Alt Tag + Bestandsnaam Helper werkt!</h1>
    <p>${SHOPIFY_SHOP_DOMAIN ? "✅" : "⚠️"} Winkel: ${SHOPIFY_SHOP_DOMAIN || "niet ingesteld"}</p>
    <p>${SHOPIFY_CLIENT_ID ? "✅" : "⚠️"} Client ID</p>
    <p>${SHOPIFY_CLIENT_SECRET ? "✅" : "⚠️"} Client Secret</p>
    <h2>Webhook URL:</h2>
    <p><code>${req.protocol}://${req.get("host")}/webhook/product-created</code></p>
  `);
});

const POORT = process.env.PORT || 3000;
app.listen(POORT, () => {
  console.log(`\n🚀 Alt Tag + Bestandsnaam Helper v6 gestart op poort ${POORT}`);
  console.log(`🏪 Winkel: ${SHOPIFY_SHOP_DOMAIN || "⚠️  Nog niet ingesteld"}`);
  console.log(`🔑 Client ID: ${SHOPIFY_CLIENT_ID ? "✅" : "⚠️  Nog niet ingesteld"}`);
  console.log(`\nKlaar!\n`);
});
