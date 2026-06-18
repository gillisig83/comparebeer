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

    setStatus("Fetching Vínbúðin beers...");
    const siteBeers = await fetchVinbudinBeers();
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
            const breweryName = breweryColumn
              ? cleanText(row[breweryColumn])
              : "";

            if (!beerName) {
              return null;
            }

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
   VÍNBÚÐIN FETCHING
----------------------------- */

async function fetchVinbudinBeers() {
  const response = await fetch("/.netlify/functions/vinbudin-beers");

  if (!response.ok) {
    throw new Error("Could not fetch Vínbúðin beer data.");
  }

  const data = await response.json();

  if (!Array.isArray(data.beers)) {
    throw new Error("Vínbúðin beer data was not in the expected format.");
  }

  return data.beers.map((beer) => {
    return {
      ...beer,
      key: createBeerKey(beer.name, beer.brewery),
      nameKey: normalizeForCompare(beer.name)
    };
  });
}

/* -----------------------------
   COMPARISON
----------------------------- */

function findNotTastedBeers(siteBeers, ratedBeers) {
  return siteBeers.filter((siteBeer) => {
    const siteName = siteBeer.nameKey;

    if (!siteName) {
      return false;
    }

    const closeMatch = ratedBeers.some((ratedBeer) => {
      const ratedName = ratedBeer.nameKey;

      if (!ratedName) {
        return false;
      }

      if (ratedName === siteName) {
        return true;
      }

      if (ratedName.includes(siteName)) {
        return true;
      }

      if (siteName.includes(ratedName)) {
        return true;
      }

      return similarityScore(ratedName, siteName) >= 0.86;
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
      `<p class="empty">No new beers found. Either you have tasted them all, or matching was too aggressive.</p>`;
    return;
  }

  beers.forEach((beer) => {
    const card = document.createElement("article");
    card.className = "beer-card";

    const imageHtml = beer.image
      ? `<img src="${escapeHtml(beer.image)}" alt="${escapeHtml(beer.name)}" loading="lazy" />`
      : `<div class="missing-image">No image</div>`;

    const details = [
      beer.brewery,
      beer.style,
      beer.abv ? `${beer.abv}%` : "",
      beer.volume ? `${beer.volume} ml` : "",
      beer.price ? `${beer.price} kr.` : ""
    ]
      .filter(Boolean)
      .join(" · ");

    card.innerHTML = `
      ${imageHtml}
      <div class="beer-info">
        <h3>${escapeHtml(beer.name)}</h3>
        <p>${escapeHtml(details || "Vínbúðin beer")}</p>
        <a href="${escapeHtml(beer.url)}" target="_blank" rel="noopener noreferrer">
          Open product
        </a>
      </div>
    `;

    resultsEl.appendChild(card);
  });
}

/* -----------------------------
   NORMALIZATION
----------------------------- */

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
    .replace(
      /\b(beer|ale|lager|ipa|neipa|dipa|stout|porter|can|bottle|draught|dose|flaska|bjor|nr)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/* -----------------------------
   FUZZY MATCHING
----------------------------- */

function similarityScore(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (!longer.length) {
    return 1;
  }

  const distance = levenshteinDistance(longer, shorter);

  return (longer.length - distance) / longer.length;
}

function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/* -----------------------------
   UI HELPERS
----------------------------- */

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
