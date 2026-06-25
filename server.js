// ============================================================
// Sportbrillenshop - Automatische Alt Tag & Bestandsnaam Updater
// ============================================================
// Dit programma luistert naar nieuwe producten in jouw Shopify
// winkel en past automatisch de alt tags van foto's aan.
// ============================================================

const express = require("express");
const crypto = require("crypto");

const app = express();

// --- INSTELLINGEN ---
// Vul deze drie gegevens in (zie de installatiegids)
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Jouw geheime sleutel
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;   // bijv. sportbrillenshop.myshopify.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;             // Geheime code voor de bel

// Shopify stuurt de data als ruwe tekst — dit zorgt dat we die kunnen lezen
app.use(express.raw({ type: "application/json" }));

// ============================================================
// DE HELPER FUNCTIE: Maakt een mooie bestandsnaam
// Voorbeeld: "Oakley Jawbreaker Rood" → "Oakley-Jawbreaker-Rood"
// ============================================================
function maakBestandsnaam(producttitel) {
  return producttitel
    .trim()
    .replace(/\s+/g, "-")        // Spaties → streepjes
    .replace(/[^a-zA-Z0-9\-]/g, "") // Verwijder rare tekens
    .replace(/-+/g, "-");        // Dubbele streepjes → één streepje
}

// ============================================================
// CONTROLEER OF HET BERICHT ECHT VAN SHOPIFY KOMT
// (Zoals een postbode die een identiteitsbewijs laat zien)
// ============================================================
function isEchtShopifyBericht(body, handtekening) {
  if (!WEBHOOK_SECRET) return true; // Sla over als geen secret ingesteld

  const verwachteHandtekening = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(handtekening || ""),
    Buffer.from(verwachteHandtekening)
  );
}

// ============================================================
// STAP 2: Haal alle foto's op van een product
// ============================================================
async function haalFotoOp(productId) {
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
            }
          }
        }
      }
    }
  `;

  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables: { id: productId } }),
    }
  );

  const data = await response.json();
  return data.data?.product;
}

// ============================================================
// STAP 3: Pas de alt tag aan van één foto
// ============================================================
async function pasAltTagAan(productId, mediaId, nieuweAltTag) {
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
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
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
// DE HOOFDFUNCTIE: Verwerkt een nieuw product
// ============================================================
async function verwerkNieuwProduct(productData) {
  const shopifyProductId = `gid://shopify/Product/${productData.id}`;
  const producttitel = productData.title;
  const altTag = maakBestandsnaam(producttitel);

  console.log(`\n🛍️  Nieuw product gevonden: "${producttitel}"`);
  console.log(`📝 Alt tag wordt: "${altTag}"`);

  // Wacht even — Shopify heeft soms een seconde nodig om foto's te verwerken
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Haal de foto's op
  const product = await haalFotoOp(shopifyProductId);

  if (!product) {
    console.log("❌ Product niet gevonden in Shopify");
    return;
  }

  const fotos = product.media?.edges || [];
  console.log(`📸 Aantal foto's gevonden: ${fotos.length}`);

  if (fotos.length === 0) {
    console.log("ℹ️  Geen foto's bij dit product — niets te doen");
    return;
  }

  // Pas elke foto aan
  let aantalGelukt = 0;
  for (const { node: foto } of fotos) {
    if (foto.mediaContentType !== "IMAGE") continue; // Sla video's over

    console.log(`  🖼️  Foto ${foto.id} aanpassen...`);
    const resultaat = await pasAltTagAan(shopifyProductId, foto.id, altTag);

    if (resultaat?.mediaUserErrors?.length > 0) {
      console.log(`  ❌ Fout: ${resultaat.mediaUserErrors[0].message}`);
    } else {
      console.log(`  ✅ Alt tag ingesteld op: "${altTag}"`);
      aantalGelukt++;
    }
  }

  console.log(`\n🎉 Klaar! ${aantalGelukt} foto('s) bijgewerkt voor "${producttitel}"`);
}

// ============================================================
// DE BEL: Luistert naar berichten van Shopify
// ============================================================
app.post("/webhook/product-created", async (req, res) => {
  const handtekening = req.headers["x-shopify-hmac-sha256"];

  // Controleer of het bericht echt van Shopify komt
  if (!isEchtShopifyBericht(req.body, handtekening)) {
    console.log("⚠️  Vals bericht ontvangen — genegeerd");
    return res.status(401).send("Ongeautoriseerd");
  }

  // Stuur meteen "ontvangen!" terug naar Shopify (anders denkt Shopify dat het mislukt is)
  res.status(200).send("Ontvangen!");

  // Verwerk het product op de achtergrond
  try {
    const productData = JSON.parse(req.body.toString());
    await verwerkNieuwProduct(productData);
  } catch (fout) {
    console.error("❌ Fout bij verwerken:", fout.message);
  }
});

// Webhook voor product updates (als je ook bestaande producten wilt bijwerken)
app.post("/webhook/product-updated", async (req, res) => {
  const handtekening = req.headers["x-shopify-hmac-sha256"];

  if (!isEchtShopifyBericht(req.body, handtekening)) {
    return res.status(401).send("Ongeautoriseerd");
  }

  res.status(200).send("Ontvangen!");

  try {
    const productData = JSON.parse(req.body.toString());
    // Alleen verwerken als het product net foto's heeft gekregen
    if (productData.images && productData.images.length > 0) {
      await verwerkNieuwProduct(productData);
    }
  } catch (fout) {
    console.error("❌ Fout bij verwerken:", fout.message);
  }
});

// Test-pagina om te controleren of alles werkt
app.get("/", (req, res) => {
  res.send(`
    <h1>✅ Sportbrillenshop Alt Tag Helper werkt!</h1>
    <p>Dit programma luistert naar nieuwe producten en past automatisch de alt tags aan.</p>
    <p>Webhook URL: <code>${req.protocol}://${req.get("host")}/webhook/product-created</code></p>
  `);
});

// Start het programma
const POORT = process.env.PORT || 3000;
app.listen(POORT, () => {
  console.log(`\n🚀 Sportbrillenshop Alt Tag Helper gestart op poort ${POORT}`);
  console.log(`🏪 Winkel: ${SHOPIFY_SHOP_DOMAIN || "⚠️  Nog niet ingesteld"}`);
  console.log(`🔑 Access token: ${SHOPIFY_ACCESS_TOKEN ? "✅ Ingesteld" : "⚠️  Nog niet ingesteld"}`);
  console.log(`\nKlaar om berichten van Shopify te ontvangen!\n`);
});
