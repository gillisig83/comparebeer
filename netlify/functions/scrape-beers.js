const cheerio = require("cheerio");

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

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueByNameAndUrl(beers) {
  const seen = new Set();
  return beers.filter((beer) => {
    const key = `${beer.name.toLowerCase()}|${beer.url || ""}`;
    if (!beer.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonLd($, baseUrl) {
  const beers = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];

      const flatten = (node) => {
        if (!node) return [];
        if (Array.isArray(node)) return node.flatMap(flatten);
        const graph = node["@graph"] ? flatten(node["@graph"]) : [];
        return [node, ...graph];
      };

      for (const node of nodes.flatMap(flatten)) {
        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
        const looksLikeProduct = String(type || "").toLowerCase().includes("product");

        if (!looksLikeProduct || !node.name) continue;

        const image = Array.isArray(node.image) ? node.image[0] : node.image;
        const brand = typeof node.brand === "object" ? node.brand?.name : node.brand;

        beers.push({
          name: cleanText(node.name),
          brewery: cleanText(brand || ""),
          image: absoluteUrl(image, baseUrl),
          url: absoluteUrl(node.url, baseUrl)
        });
      }
    } catch {
      // Some sites have invalid JSON-LD. Ignore and continue with HTML parsing.
    }
  });

  return beers;
}

function parseGenericProductCards($, baseUrl) {
  const beers = [];
  const selectors = [
    "[data-product-id]",
    ".product",
    ".product-card",
    ".product-item",
    ".grid-product",
    ".card",
    "article"
  ];

  $(selectors.join(",")).each((_, element) => {
    const card = $(element);

    const link = card.find("a[href]").first();
    const href = link.attr("href");

    const title =
      card.find("[itemprop='name']").first().text() ||
      card.find(".product-title, .product-name, .card-title, h2, h3").first().text() ||
      link.attr("title") ||
      link.text();

    const image =
      card.find("img").first().attr("src") ||
      card.find("img").first().attr("data-src") ||
      card.find("img").first().attr("data-original") ||
      card.find("source").first().attr("srcset");

    const brewery =
      card.find(".brewery, .brand, .vendor, [itemprop='brand']").first().text();

    const name = cleanText(title)
      .replace(/\b\d+([,.]\d+)?\s?%\b/g, "")
      .replace(/\b\d+\s?(ml|cl|l)\b/gi, "")
      .trim();

    if (name.length < 2 || name.length > 140) return;

    beers.push({
      name,
      brewery: cleanText(brewery),
      image: absoluteUrl(String(image || "").split(" ")[0], baseUrl),
      url: absoluteUrl(href, baseUrl)
    });
  });

  return beers;
}

function parseFallbackLinks($, baseUrl) {
  const beers = [];

  $("a[href]").each((_, element) => {
    const link = $(element);
    const text = cleanText(link.text());
    const href = link.attr("href") || "";

    const beerish =
      /beer|bjor|bjór|ale|lager|ipa|stout|porter|pilsner|sour|gose|barleywine|dipa|neipa/i.test(text + " " + href);

    if (!beerish || text.length < 3 || text.length > 140) return;

    const parent = link.closest("li, article, div");
    const image =
      parent.find("img").first().attr("src") ||
      parent.find("img").first().attr("data-src");

    beers.push({
      name: text,
      brewery: "",
      image: absoluteUrl(image, baseUrl),
      url: absoluteUrl(href, baseUrl)
    });
  });

  return beers;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Use POST." })
    };
  }

  let url;

  try {
    const body = JSON.parse(event.body || "{}");
    url = body.url;
    new URL(url);
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid URL." })
    };
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 BeerCompareBot/1.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Shop page returned HTTP ${response.status}.`
        })
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const beers = uniqueByNameAndUrl([
      ...parseJsonLd($, url),
      ...parseGenericProductCards($, url),
      ...parseFallbackLinks($, url)
    ]);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: url,
        count: beers.length,
        beers
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Could not scrape that site. It may block bots, require JavaScript, or use a structure this parser does not understand.",
        detail: error.message
      })
    };
  }
};
