const csvInput = document.querySelector("#csvFile");
const shopUrlInput = document.querySelector("#shopUrl");
const compareBtn = document.querySelector("#compareBtn");
const statusEl = document.querySelector("#status");
const resultsGrid = document.querySelector("#resultsGrid");
const stats = document.querySelector("#stats");

const ratedCountEl = document.querySelector("#ratedCount");
const shopCountEl = document.querySelector("#shopCount");
const missingCountEl = document.querySelector("#missingCount");

function setStatus(message) {
  statusEl.textContent = message;
}

function extractUntappdBeers(rows) {
  return rows
    .map(row => {
      const beer =
        row.beer_name ||
        row["Beer Name"] ||
        row.beer ||
        row.Name ||
        row.name;

      const brewery =
        row.brewery_name ||
        row["Brewery Name"] ||
        row.brewery ||
        row.Brewery;

      if (!beer) return null;

      return {
        beerName: beer.trim(),
        breweryName: brewery ? brewery.trim() : "",
        searchKey: `${beer} ${brewery || ""}`
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .trim()
      };
    })
    .filter(Boolean);
}

function normalizeBeerName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\b(beer|ale|lager|ipa|dipa|neipa|stout|porter|pilsner|pale ale)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(headers, candidates) {
  const normalized = headers.map((h) => String(h || "").toLowerCase().trim());
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate.toLowerCase());
    if (index !== -1) return headers[index];
  }
  return null;
}

function parseUntappdCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if (result.errors?.length) {
          reject(new Error(result.errors[0].message));
          return;
        }

        const headers = result.meta.fields || [];
        const beerCol = findColumn(headers, [
          "beer name",
          "beer",
          "name",
          "bid_name"
        ]);

        const breweryCol = findColumn(headers, [
          "brewery name",
          "brewery",
          "brewery_name"
        ]);

        if (!beerCol) {
          reject(new Error("Could not find a beer name column in the CSV."));
          return;
        }

        const beers = result.data
          .map((row) => ({
            name: row[beerCol],
            brewery: breweryCol ? row[breweryCol] : "",
            key: normalizeBeerName(`${row[beerCol]} ${breweryCol ? row[breweryCol] : ""}`),
            looseKey: normalizeBeerName(row[beerCol])
          }))
          .filter((beer) => beer.name && beer.looseKey);

        resolve(beers);
      },
      error: reject
    });
  });
}

function beerWasRated(shopBeer, ratedKeys, ratedLooseKeys) {
  const fullKey = normalizeBeerName(`${shopBeer.name} ${shopBeer.brewery || ""}`);
  const looseKey = normalizeBeerName(shopBeer.name);

  if (ratedKeys.has(fullKey) || ratedLooseKeys.has(looseKey)) return true;

  // Fuzzy-ish fallback: helps when the shop includes can size or ABV in the title.
  for (const ratedName of ratedLooseKeys) {
    if (
      ratedName.length >= 5 &&
      looseKey.length >= 5 &&
      (ratedName.includes(looseKey) || looseKey.includes(ratedName))
    ) {
      return true;
    }
  }

  return false;
}

function renderResults(beers) {
  resultsGrid.innerHTML = "";

  if (!beers.length) {
    resultsGrid.innerHTML = `
      <div class="empty">
        No untasted beers found. Either you have tasted them all, or the shop page parser needs tuning.
      </div>
    `;
    return;
  }

  for (const beer of beers) {
    const image = beer.image || "https://placehold.co/500x500/100d0b/f7efe3?text=Beer";
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <img src="${escapeHtml(image)}" alt="${escapeHtml(beer.name)}" loading="lazy" />
      <div class="card-content">
        <h3>${escapeHtml(beer.name)}</h3>
        <p>${escapeHtml(beer.brewery || "Unknown brewery")}</p>
        ${beer.url ? `<a href="${escapeHtml(beer.url)}" target="_blank" rel="noopener">Open beer</a>` : ""}
      </div>
    `;
    resultsGrid.appendChild(card);
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

compareBtn.addEventListener("click", async () => {
  const file = csvInput.files?.[0];
  const shopUrl = shopUrlInput.value.trim();

  if (!file) {
    setStatus("Choose your Untappd CSV first.");
    return;
  }

  if (!shopUrl) {
    setStatus("Paste a beer shop URL first.");
    return;
  }

  compareBtn.disabled = true;
  resultsGrid.innerHTML = "";
  setStatus("Reading Untappd CSV...");

  try {
    const ratedBeers = await parseUntappdCsv(file);
    const ratedKeys = new Set(ratedBeers.map((beer) => beer.key));
    const ratedLooseKeys = new Set(ratedBeers.map((beer) => beer.looseKey));

    setStatus("Fetching beers from shop page...");

    const response = await fetch("/.netlify/functions/scrape-beers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: shopUrl })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not fetch shop page.");
    }

    const shopBeers = payload.beers || [];
    const notTasted = shopBeers.filter((beer) => !beerWasRated(beer, ratedKeys, ratedLooseKeys));

    ratedCountEl.textContent = String(ratedBeers.length);
    shopCountEl.textContent = String(shopBeers.length);
    missingCountEl.textContent = String(notTasted.length);
    stats.hidden = false;

    renderResults(notTasted);
    setStatus(`Done. Found ${notTasted.length} beers you have not tasted yet.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something broke. The beer goblin is denying responsibility.");
  } finally {
    compareBtn.disabled = false;
  }
});
