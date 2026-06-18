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
  const shopUrl = shopUrlInput.value.trim();

  if (!file) {
    showError("Choose your Untappd CSV file first.");
    return;
  }

  if (!shopUrl) {
    showError("Paste a beer shop URL first.");
    return;
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

/**
 * Parses Untappd CSV export.
 */
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
        console.log("First row:", rows[0]);

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

/**
 * Finds a matching column, ignoring case, spaces, underscores and hyphens.
 */
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

/**
 * Fetches the site HTML through a Netlify function to avoid CORS.
 */
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

/**
 * Extracts beer/product cards from HTML.
 *
 * This is intentionally broad because shops structure pages differently.
 */
function extractBeersFromHtml(html, pageUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const candidates = [];

  /**
   * Generic product title selectors.
   * Add more here if a shop uses different class names.
   */
  const selectors = [
    "h1",
    "h2",
    "h3",
    ".product-title",
    ".product-name",
    ".product__title",
    ".product-card",
    ".product",
    ".card",
    "article",
    "a"
  ];

  selectors.forEach((selector) => {
    doc.querySelectorAll(selector).forEach((element) => {
      const text = cleanText(element.textContent);

      if (!text) return;

      const possibleBeer = extractLikelyBeerName(text);

      if (!possibleBeer) return;

      const link = findClosestLink(element, pageUrl);
      const image = findClosestImage(element, pageUrl);

      candidates.push({
        name: possibleBeer,
        brewery: "",
        url: link,
        image,
        key: createBeerKey(possibleBeer, ""),
        nameKey: normalizeForCompare(possibleBeer)
      });
    });
  });

  const unique = dedupeBeers(candidates);

  return unique;
}

/**
 * Tries to remove shop noise and keep likely product names.
 */
function extractLikelyBeerName(text) {
  let value = cleanText(text);

  if (!value) return null;

  /**
   * Reject obvious non-product junk.
   */
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
    "header"
  ];

  const lower = value.toLowerCase();

  if (badWords.some((word) => lower.includes(word))) {
    return null;
  }

  /**
   * Many product cards include too much text.
   * Keep the first sensible line.
   */
  const lines = value
    .split(/\n| {2,}/)
    .map(cleanText)
    .filter(Boolean);

  if (lines.length) {
    value = lines[0];
  }

  /**
   * Reject very short or absurdly long strings.
   */
  if (value.length < 3 || value.length > 120) {
    return null;
  }

  /**
   * Product pages often include ABV, volume, price etc.
   * That is fine, but we clean some common endings.
   */
  value = value
    .replace(/\b\d+[,.]?\d*\s?%.*$/i, "")
    .replace(/\b\d+\s?(ml|cl|l)\b.*$/i, "")
    .replace(/\b\d+[,.]?\d*\s?kr\.?.*$/i, "")
    .trim();

  if (value.length < 3) return null;

  return value;
}

function findClosestLink(element, pageUrl) {
  const linkElement = element.closest("a") || element.querySelector?.("a");

  if (!linkElement) {
    return pageUrl;
  }

  const href = linkElement.getAttribute("href");

  if (!href) {
    return pageUrl;
  }

  try {
    return new URL(href, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

function findClosestImage(element, pageUrl) {
  const container =
    element.closest("article") ||
    element.closest(".product") ||
    element.closest(".product-card") ||
    element.closest(".card") ||
    element.parentElement;

  const img = container?.querySelector?.("img");

  if (!img) {
    return "";
  }

  const src =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src");

  if (!src) {
    return "";
  }

  try {
    return new URL(src, pageUrl).href;
  } catch {
    return "";
  }
}

/**
 * Compares site beers against tasted Untappd beers.
 */
function findNotTastedBeers(siteBeers, ratedBeers) {
  const ratedNameKeys = new Set(ratedBeers.map((beer) => beer.nameKey));
  const ratedFullKeys = new Set(ratedBeers.map((beer) => beer.key));

  return siteBeers.filter((siteBeer) => {
    if (ratedNameKeys.has(siteBeer.nameKey)) return false;
    if (ratedFullKeys.has(siteBeer.key)) return false;

    /**
     * Fuzzy-ish fallback:
     * If one name contains the other, count it as tasted.
     */
    const siteName = siteBeer.nameKey;

    const closeMatch = ratedBeers.some((ratedBeer) => {
      const ratedName = ratedBeer.nameKey;

      if (!ratedName || !siteName) return false;

      return (
        ratedName.includes(siteName) ||
        siteName.includes(ratedName)
      );
    });

    return !closeMatch;
  });
}

function dedupeBeers(beers) {
  const seen = new Set();
  const unique = [];

  beers.forEach((beer) => {
    const key = beer.nameKey;

    if (!key || seen.has(key)) return;

    seen.add(key);
    unique.push(beer);
  });

  return unique;
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
    .replace(/\b(beer|ale|lager|ipa|stout|porter|can|bottle|draught)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderResults(beers) {
  resultsEl.innerHTML = "";

  if (!beers.length) {
    resultsEl.innerHTML = `<p class="empty">No new beers found. Either you have tasted them all, or the site is hiding the beer names like a goblin.</p>`;
    return;
  }

  beers.forEach((beer) => {
    const card = document.createElement("article");
    card.className = "beer-card";

    const imageHtml = beer.image
      ? `<img src="${escapeHtml(beer.image)}" alt="${escapeHtml(beer.name)}" loading="lazy" />`
      : `<img src="" alt="" />`;

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
