// ============================================================
// Sportbrillenshop - Automatische Alt Tag + Bestandsnaam Updater
// Versie 4 - slaat gedeelde foto's over
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
// STAP 1: Haal alle foto's op van een product
// ============================================================
async function haalFotosOp(productId, token) {
  const query = `
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
  `;

  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables: { id: productId } }),
    }
  );

  const data = await response.json();
  return data.data?.product;
}

// ============================================================
// STAP 2: Controleer hoeveel producten deze foto gebruiken
// Als meer dan 1 product → foto overslaan
// ============================================================
async function haalAantalProductenOp(mediaId, token) {
  const query = `
    query checkFileReferences($id: ID!) {
      file(id: $id) {
        ... on MediaImage {
          id
          fileStatus
          references(first: 10) {
            edges {
              node {
                ... on Product {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables: { id: mediaId } }),
    }
  );

  const data = await response.json();
  const references = data.data?.file?.references?.edges || [];

  // Filter alleen op producten (niet varianten of andere referenties)
  const producten = references.filter(edge => edge.node?.id?.includes("Product"));
  return producten.length;
}

// ============================================================
// STAP 3: Pas alt tag aan
// ============================================================
async function pasAltTagAan(productId, mediaId, nieuweAltTag, token) {
  const mutation = `
    mutation updateMediaAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $productId, media: $media) {
        media {
          id
          alt
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          productId,
          media: [{ id: mediaId, alt: nieuweAltTag }],
        },
      }),
    }
  );

  const data = await response.json();
  return data.data?.productUpdateMedia;
}

// ============================================================
// STAP 4: Pas bestandsnaam aan
// ============================================================
async function pasBestandsnaamAan(mediaId, nieuweNaam, mimeType, token) {
  let extensie = ".jpg";
  if (mimeType === "image/png") extensie = ".png";
  else if (mimeType === "image/webp") extensie = ".webp";
  else if (mimeType === "image/gif") extensie = ".gif";

  const nieuweBestandsnaam = `${nieuweNaam}${extensie}`;

  const mutation = `
    mutation fileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          files: [{ id: mediaId, filename: nieuweBestandsnaam }],
        },
      }),
    }
  );

  const data = await response.json();
  return data.data?.fileUpdate;
}

// ============================================================
// HOOFDFUNCTIE: Verwerkt een nieuw/bijgewerkt product
// ============================================================
async function verwerkNieuwProduct(productData) {
  const shopifyProductId = `gid://shopify/Product/${productData.id}`;
  const producttitel = productData.title;
  const nieuweNaam = maakNaam(producttitel);

  console.log(`\n🛍️  Product: "${producttitel}"`);
  console.log(`📝 Nieuwe naam wordt: "${nieuweNaam}"`);

  const token = await haalToegangstokenOp();

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

    // Controleer of de foto bij meerdere producten wordt gebruikt
    const aantalProducten = await haalAantalProductenOp(foto.id, token);

    if (aantalProducten > 1) {
      console.log(`  ⏭️  Foto overgeslagen — wordt gebruikt door ${aantalProducten} producten`);
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
    } else {
      const extensie = foto.mimeType === "image/png" ? ".png" : foto.mimeType === "image/webp" ? ".webp" : ".jpg";
      console.log(`  ✅ Bestandsnaam: "${nieuweNaam}${extensie}"`);
      aantalGelukt++;
    }
  }

  console.log(`\n🎉 Klaar! ${aantalGelukt} foto('s) bijgewerkt, ${aantalOvergeslagen} overgeslagen (gedeeld) voor "${producttitel}"`);
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
  const shopIngesteld = SHOPIFY_SHOP_DOMAIN ? "✅" : "⚠️  Nog niet ingesteld";
  const clientIdIngesteld = SHOPIFY_CLIENT_ID ? "✅" : "⚠️  Nog niet ingesteld";
  const clientSecretIngesteld = SHOPIFY_CLIENT_SECRET ? "✅" : "⚠️  Nog niet ingesteld";

  res.send(`
    <h1>✅ Sportbrillenshop Alt Tag + Bestandsnaam Helper werkt!</h1>
    <h2>Status:</h2>
    <p>${shopIngesteld} Winkel: ${SHOPIFY_SHOP_DOMAIN || "niet ingesteld"}</p>
    <p>${clientIdIngesteld} Client ID</p>
    <p>${clientSecretIngesteld} Client Secret</p>
    <h2>Webhook URL:</h2>
    <p><code>${req.protocol}://${req.get("host")}/webhook/product-created</code></p>
  `);
});

// Start
const POORT = process.env.PORT || 3000;
app.listen(POORT, () => {
  console.log(`\n🚀 Alt Tag + Bestandsnaam Helper gestart op poort ${POORT}`);
  console.log(`🏪 Winkel: ${SHOPIFY_SHOP_DOMAIN || "⚠️  Nog niet ingesteld"}`);
  console.log(`🔑 Client ID: ${SHOPIFY_CLIENT_ID ? "✅" : "⚠️  Nog niet ingesteld"}`);
  console.log(`\nKlaar!\n`);
});
