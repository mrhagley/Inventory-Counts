# Shelf Count

A phone web app for inventory counts. A technician photographs a shelf or bin, Claude counts the parts, the technician corrects any numbers, and the counts export to a spreadsheet. It does not keep a running inventory.

The parts list (name and SKU) lives in `public/parts.json`.

## How it works

- `public/index.html` is the whole front end. No build step.
- `server.js` is a small Express server. It serves the page and exposes `POST /api/count`, which sends the photo and parts list to the Anthropic API and returns the counts. Your API key stays on the server.
- Counts and the technician's edits to the parts list are stored in the phone's browser only. Nothing is saved on the server.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, choose **New Project**, then **Deploy from GitHub repo**, and pick the repository. Railway detects Node and runs `npm start`.
3. Open the service's **Variables** tab and add:
   - `ANTHROPIC_API_KEY`: a key from https://console.anthropic.com
   - `ACCESS_CODE`: any code you choose. Technicians enter it once on their phone. Without it, anyone who finds the link can spend your API credit.
   - Optional: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and `RATE_LIMIT_PER_MINUTE` (default `20` per IP address).
4. Open **Settings**, then **Networking**, and choose **Generate Domain**.
5. Open the domain on a phone. Use **Share**, then **Add to Home Screen**, so it opens like an app.

Each count is one request billed to your Anthropic account.

## Run locally

```bash
npm install
cp .env.example .env     # then fill in ANTHROPIC_API_KEY and ACCESS_CODE
npm run dev              # needs Node 20.6 or newer
```

Open http://localhost:3000. The camera button needs HTTPS on a real phone, so test the camera on the Railway domain. Choosing a photo from the library works over plain http.

## Updating the parts list

Edit `public/parts.json` (an array of `{ "name": "...", "sku": "..." }`) and push. Phones that have not edited their list pick up the new one on the next load. A phone that has edited its list keeps its own until the technician taps **Restore original list** on the Parts tab.

## Notes

- Photos are resized on the phone to 1600 pixels on the long side before upload.
- `GET /healthz` returns `ok` for Railway's health check.
- Rate limiting is in memory, so it resets when the service restarts.
