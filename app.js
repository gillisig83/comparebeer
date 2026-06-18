const csvFileInput = document.getElementById("csvFile");
const shopUrlInput = document.getElementById("shopUrl");
const compareBtn = document.getElementById("compareBtn");

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");

const ratedCountEl = document.getElementById("ratedCount");
const siteCountEl = document.getElementById("siteCount");
const notTastedCountEl = document.getElementById("notTastedCount");

const resultsEl = document.getElementById("results");

compareBtn.addEventListener("click", handleCompare);

async function handleCompare() {
  clearMessages();
  clearResults();

  const file = csvFileInput.files[0];
  let shopUrl = shopUrlInput.value.trim();

  if (!file) {
    showError("Choose your Untappd CSV file first.");
    return;
  }

  if (!shopUrl) {
    showError("Paste a beer shop URL first.");
    return;
  }

  /*
    Vínbúðin /heim/vorur is mostly a category/menu page.
    The real product list is usually /heim/vorur/vorur.
  */
  if (shopUrl === "https://www.vinbudin.is/heim/vorur") {
    shopUrl = "https://www.vinbudin.is/heim/vorur/vorur";
    shopUrlInput.value = shopUrl;
  }

  try {
    compareBtn.disabled = true;

    setStatus("Reading Untappd CSV...");
    const ratedBeers = await parseUntappdCsv(file);
    ratedCountEl.textContent = ratedBeers.length;

    setStatus("Fetching beer shop page...");
    const siteBeers = await fetchBeersFromSite(shopUrl);
    siteCountEl.textContent = siteBeers.length;

    setStatus("Comparing beers...");
    const notTasted = findNotTastedBeers(siteBeers, ratedBeers);
    notTastedCountEl.textContent = notTasted.length;

    renderResults(notTasted);

    setStatus("Done.");
  } catch (error) {
    console.error(error);
    showError(error.message || "Something went wrong.");
  } finally {
    compareBtn.disabled = false;
  }
}

/* -----------------------------
   CSV PARSING
----------------------------- */

function parseUntappdCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (results) => {
        const rows = results.data || [];
        const headers = results.meta.fields || [];

        console.log("CSV headers:", headers);
        console.log("First CSV row:", rows[0]);

        if (!headers.length) {
          reject(new Error("No CSV headers found. Is this a real CSV export?"));
          return;
        }

        const beerColumn = findColumn(headers, [
          "beer",
          "beer name",
          "beer_name",
          "beername",
          "name",
          "title"
        ]);

        const breweryColumn = findColumn(headers, [
          "brewery",
          "brewery name",
          "brewery_name",
          "breweryname"
        ]);

        if (!beerColumn) {
          reject(
            new Error(
              `Could not find a beer name column in the CSV. Found columns: ${headers.join(
                " | "
              )}`
            )
          );
          return;
        }

        const beers = rows
          .map((row) => {
            const beerName = cleanText(row[beerColumn]);
            const breweryName = breweryColumn ? cleanText(row[breweryColumn]) : "";

            if (!beerName) return null;

            return {
              name: beerName,
              brewery: breweryName,
              key: createBeerKey(beerName, breweryName),
              nameKey: normalizeForCompare(beerName)
            };
          })
          .filter(Boolean);

        resolve(beers);
      },
      error: (error) => {
        reject(error);
      }
    });
  });
}

function findColumn(headers, possibleNames) {
  const normalizedPossibleNames = possibleNames.map(normalizeHeader);

  return headers.find((header) => {
    return normalizedPossibleNames.includes(normalizeHeader(header));
  });
}

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "");
}

/* -----------------------------
   SITE FETCHING
----------------------------- */

async function fetchBeersFromSite(url) {
  const response = await fetch(
    `/.netlify/functions/fetch-page?url=${encodeURIComponent(url)}`
  );

  if (!response.ok) {
    throw new Error("Could not fetch the beer shop page.");
  }

  const data = await response.json();

  if (!data.html) {
    throw new Error("No HTML received from the beer shop page.");
  }

  return extractBeersFromHtml(data.html, url);
}

/* -----------------------------
   HTML PRODUCT EXTRACTION
----------------------------- */

function extractBeersFromHtml(html, pageUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const host = getHost(pageUrl);

  if (host.includes("vinbudin.is")) {
    return extractVinbudinProducts(doc, pageUrl);
  }

  return extractGenericShopProducts(doc, pageUrl);
}

/*
  Vínbúðin fix:
  Only collect actual product links.

  Product links usually contain:
  stoek-vara.aspx/?productid=...
*/
function extractVinbudinProducts(doc, pageUrl) {
  const products = [];

  const productLinks = Array.from(
    doc.querySelectorAll('a[href*="stoek-vara"], a[href*="productid"]')
  );

  productLinks.forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;

    const productUrl = makeAbsoluteUrl(href, pageUrl);

    const productId = getProductId(productUrl);
    if (!productId) return;

    const container =
      link.closest("tr") ||
      link.closest("li") ||
      link.closest("article") ||
      link.closest(".product") ||
      link.closest(".product-item") ||
      link.closest(".product-list-item") ||
      link.parentElement;

    const rawText = cleanText(
      container?.textContent || link.textContent || ""
    );

    const name = extractVinbudinProductName(rawText, link.textContent, productId);

    if (!name) return;

    const image = findImageNearElement(container || link, pageUrl);

    products.push({
      name,
      brewery: "",
      url: productUrl,
      image,
      productId,
      key: createBeerKey(name, ""),
      nameKey: normalizeForCompare(name)
    });
  });

  return dedupeProducts(products);
}

function extractVinbudinProductName(containerText, linkText, productId) {
  let value = cleanText(linkText);

  if (!value || value.length < 3) {
    value = cleanText(containerText);
  }

  if (!value) return null;

  /*
    Remove obvious menu junk.
  */
  const lower = value.toLowerCase();

  const badValues = [
    "loka",
    "opnunartímar",
    "vörur",
    "allar vörur",
    "bjór",
    "vefbúð",
    "leit",
    "karfa",
    "innskráning",
    "forsíða",
    "næsta síða",
    "fyrri síða"
  ];

  if (badValues.includes(lower)) {
    return null;
  }

  /*
    Product names often appear like:
    Duvel (08114)
    or inside a longer text block.

    Try to grab the part before product number.
  */
  const idPattern = new RegExp(`(.+?)\\(?${escapeRegExp(productId)}\\)?`);
  const idMatch = value.match(idPattern);

  if (idMatch && idMatch[1]) {
    value = idMatch[1];
  }

  /*
    Remove price, volume, ABV and product number noise.
  */
  value = value
    .replace(/\(\d{4,8}\)/g, "")
    .replace(/\b\d{4,8}\b/g, "")
    .replace(/\b\d+[,.]?\d*\s?%.*$/i, "")
    .replace(/\b\d+\s?(ml|cl|l|lítrar)\b.*$/i, "")
    .replace(/\b\d+[,.]?\d*\s?kr\.?.*$/i, "")
    .replace(/\bverð\b.*$/i, "")
    .replace(/\bprice\b.*$/i, "")
    .trim();

  /*
    If the text block has many words from the whole product card,
    keep only the first line-ish part.
  */
  value = value
    .split("  ")
    .map(cleanText)
    .filter(Boolean)[0] || value;

  if (value.length < 3 || value.length > 90) {
    return null;
  }

  return value;
}

/*
  Fallback for other shops.
  This is stricter than the old one:
  it does NOT collect every menu link.
*/
function extractGenericShopProducts(doc, pageUrl) {
  const products = [];

  const productSelectors = [
    ".product",
    ".product-card",
    ".product-item",
    ".product-list-item",
    "[class*='product']",
    "article"
  ];

  productSelectors.forEach((selector) => {
    doc.querySelectorAll(selector).forEach((element) => {
      const text = cleanText(element.textContent);
      const name = extractGenericProductName(text);

      if (!name) return;

      const url = findClosestLink(element, pageUrl);
      const image = findImageNearElement(element, pageUrl);

      products.push({
        name,
        brewery: "",
        url,
        image,
        key: createBeerKey(name, ""),
        nameKey: normalizeForCompare(name)
      });
    });
  });

  return dedupeProducts(products);
}

function extractGenericProductName(text) {
  let value = cleanText(text);

  if (!value) return null;

  const lower = value.toLowerCase();

  const badWords = [
    "choose file",
    "compare beers",
    "rated beers",
    "not tasted",
    "shopping cart",
    "login",
    "menu",
    "search",
    "privacy",
    "cookie",
    "terms",
    "footer",
    "header",
    "opening hours",
    "opnunartímar"
  ];

  if (badWords.some((word) => lower.includes(word))) {
    return null;
  }

  const lines = value
    .split(/\n| {2,}/)
    .map(cleanText)
    .filter(Boolean);

  if (lines.length) {
    value = lines[0];
  }

  value = value
    .replace(/\b\d+[,.]?\d*\s?%.*$/i, "")
    .replace(/\b\d+\s?(ml|cl|l)\b.*$/i, "")
    .replace(/\b\d+[,.]?\d*\s?kr\.?.*$/i, "")
    .trim();

  if (value.length < 3 || value.length > 90) {
    return null;
  }

  return value;
}

/* -----------------------------
   COMPARISON
----------------------------- */

function findNotTastedBeers(siteBeers, ratedBeers) {
  const ratedNameKeys = new Set(ratedBeers.map((beer) => beer.nameKey));
  const ratedFullKeys = new Set(ratedBeers.map((beer) => beer.key));

  return siteBeers.filter((siteBeer) => {
    if (ratedNameKeys.has(siteBeer.nameKey)) return false;
    if (ratedFullKeys.has(siteBeer.key)) return false;

    const siteName = siteBeer.nameKey;

    const closeMatch = ratedBeers.some((ratedBeer) => {
      const ratedName = ratedBeer.nameKey;

      if (!ratedName || !siteName) return false;

      return ratedName.includes(siteName) || siteName.includes(ratedName);
    });

    return !closeMatch;
  });
}

/* -----------------------------
   RENDERING
----------------------------- */

function renderResults(beers) {
  resultsEl.innerHTML = "";

  if (!beers.length) {
    resultsEl.innerHTML =
      `<p class="empty">No new beers found. Either you have tasted them all, or the page did not expose product data.</p>`;
    return;
  }

  beers.forEach((beer) => {
    const card = document.createElement("article");
    card.className = "beer-card";

    const imageHtml = beer.image
      ? `<img src="${escapeHtml(beer.image)}" alt="${escapeHtml(beer.name)}" loading="lazy" />`
      : `<div class="missing-image">No image</div>`;

    card.innerHTML = `
      ${imageHtml}
      <div class="beer-info">
        <h3>${escapeHtml(beer.name)}</h3>
        ${
          beer.brewery
            ? `<p>${escapeHtml(beer.brewery)}</p>`
            : `<p>Found on beer shop page</p>`
        }
        <a href="${escapeHtml(beer.url)}" target="_blank" rel="noopener noreferrer">
          Open product
        </a>
      </div>
    `;

    resultsEl.appendChild(card);
  });
}

/* -----------------------------
   HELPERS
----------------------------- */

function dedupeProducts(products) {
  const seen = new Set();
  const unique = [];

  products.forEach((product) => {
    const key = product.productId || product.nameKey;

    if (!key || seen.has(key)) return;

    seen.add(key);
    unique.push(product);
  });

  return unique;
}

function getProductId(url) {
  try {
    const parsed = new URL(url);
    const productId = parsed.searchParams.get("productid");

    if (productId) {
      return productId.replace(/\D/g, "");
    }

    const match = url.match(/productid=([0-9]+)/i);
    return match ? match[1] : "";
  } catch {
    const match = String(url).match(/productid=([0-9]+)/i);
    return match ? match[1] : "";
  }
}

function findClosestLink(element, pageUrl) {
  const linkElement = element.closest?.("a") || element.querySelector?.("a");

  if (!linkElement) {
    return pageUrl;
  }

  const href = linkElement.getAttribute("href");

  if (!href) {
    return pageUrl;
  }

  return makeAbsoluteUrl(href, pageUrl);
}

function findImageNearElement(element, pageUrl) {
  if (!element) return "";

  const img =
    element.querySelector?.("img") ||
    element.closest?.("article")?.querySelector?.("img") ||
    element.closest?.(".product")?.querySelector?.("img") ||
    element.closest?.(".product-item")?.querySelector?.("img");

  if (!img) return "";

  const src =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("data-original");

  if (!src) return "";

  return makeAbsoluteUrl(src, pageUrl);
}

function makeAbsoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function createBeerKey(name, brewery) {
  return normalizeForCompare(`${name} ${brewery || ""}`);
}

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ð/g, "d")
    .replace(/þ/g, "th")
    .replace(/æ/g, "ae")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(beer|ale|lager|ipa|stout|porter|can|bottle|draught|dose|flaska)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clearResults() {
  ratedCountEl.textContent = "0";
  siteCountEl.textContent = "0";
  notTastedCountEl.textContent = "0";
  resultsEl.innerHTML = "";
}

function clearMessages() {
  statusEl.textContent = "";
  errorEl.textContent = "";
}

function setStatus(message) {
  statusEl.textContent = message;
  errorEl.textContent = "";
}

function showError(message) {
  errorEl.textContent = message;
  statusEl.textContent = "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
