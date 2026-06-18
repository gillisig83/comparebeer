exports.handler = async function (event) {
  try {
    const url = event.queryStringParameters?.url;

    if (!url) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing URL."
        })
      };
    }

    const parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Only HTTP and HTTPS URLs are allowed."
        })
      };
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; UntappdBeerFinder/1.0; +https://netlify.app)",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Failed to fetch page. Status: ${response.status}`
        })
      };
    }

    const html = await response.text();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        url,
        html
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Server error."
      })
    };
  }
};
