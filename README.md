# Untappd Beer Finder for Netlify

Upload an Untappd CSV export, paste a beer shop URL, and the app shows beers from that shop page that are not in your Untappd history.

## Deploy to Netlify

1. Create a new GitHub repo.
2. Copy these files into the repo.
3. In Netlify, choose **Add new site → Import an existing project**.
4. Pick the repo.
5. Netlify settings:
   - Build command: leave empty
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
6. Deploy.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Netlify URL.

## Untappd CSV columns

The app looks for these columns:

- Beer Name / Beer / Name
- Brewery Name / Brewery

Untappd exports usually include `Beer Name` and `Brewery Name`.

## Important limitation

Many shop sites render products with JavaScript or block scrapers. This app uses a generic HTML parser:

- JSON-LD Product data
- common product card classes
- beer-like links as fallback

For best results, make a custom parser for the exact beer shop you want to use.
