import { getProducts } from "vinbudin";

export async function handler() {
  try {
    const products = await getProducts({
      beer: true
    });

    const beers = products
      .map((product) => {
        const productId = String(product.productId || "").trim();
        const name = String(product.productName || "").trim();

        if (!productId || !name) {
          return null;
        }

        return {
          productId,
          name,
          brewery: product.productProducer || "",
          style:
            product.productSubCategory?.name ||
            product.productTasteGroup2Description ||
            product.productCategory?.name ||
            "Beer",
          abv: product.productAlchoholVolume || "",
          volume: product.productBottledVolume || "",
          price: product.productPrice || "",
          inventory: product.productInventory || 0,
          image:
            product.productImages?.medium ||
            product.productImages?.original ||
            "",
          url: `https://www.vinbudin.is/heim/vorur/stoek-vara.aspx/?productid=${productId}/`
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600"
      },
      body: JSON.stringify({
        count: beers.length,
        beers
      })
    };
  } catch (error) {
    console.error("Vínbúðin fetch failed:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: error.message || "Could not fetch Vínbúðin beers."
      })
    };
  }
}
