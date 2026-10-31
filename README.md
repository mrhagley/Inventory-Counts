# Shelf Count

A phone web app for inventory counts. A technician photographs a shelf or bin, Claude counts the parts, the technician corrects any numbers, and the counts export to a spreadsheet. It does not keep a running inventory.

The parts list (name and SKU) lives in `parts.json` at the project root. Technicians cannot see or edit it in the app.

## How it works

- `public/index.html` is the whole front end. No build step.
- `server.js` is a small Express server. It serves the page and exposes `POST /api/count`, which sends the photo and parts list to the Anthropic API and returns the counts. Your API key stays on the server.
- Counts are stored in the phone's browser only. Nothing is saved on the server. Submitted counts are emailed, not stored.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, choose **New Project**, then **Deploy from GitHub repo**, and pick the repository. Railway detects Node and runs `npm start`.
3. Open the service's **Variables** tab and add:
   - `ANTHROPIC_API_KEY`: a key from https://console.anthropic.com
   - `ACCESS_CODE`: any code you choose. Technicians enter it once on their phone. Without it, anyone who finds the link can spend your API credit.
   - Only if the API returns a "not scoped to a workspace" error: `ANTHROPIC_WORKSPACE_ID`, or create a new key inside a workspace instead.
   - For email submissions: `RESEND_API_KEY` and `EMAIL_TO` (comma-separated addresses). See "Email setup" below.
   - Optional: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and `RATE_LIMIT_PER_MINUTE` (default `20` per IP address).
4. Open **Settings**, then **Networking**, and choose **Generate Domain**.
5. Open the domain on a phone. Use **Share**, then **Add to Home Screen**, so it opens like an app.

Each count is one request billed to your Anthropic account.

## Email setup

When a technician taps **Submit and email** on the Session tab, the server emails one spreadsheet (CSV) to the office and the phone clears its session. The email shows the technician name and the date processed, and the spreadsheet has both as columns. Each part appears once per technician and date, with the quantities from every photo added together.

1. Create an account at https://resend.com and create an API key. Set it as `RESEND_API_KEY`.
2. Set `EMAIL_TO` to the address or addresses that should receive the counts.
   Optional: set `PHOTO_EMAIL_TO` to send the photos to a different address in a separate email. If it is not set, the photos are attached to the same email as the spreadsheet.
3. Testing: with no `EMAIL_FROM` set, Resend only delivers to the email address on your Resend account.
4. To send to anyone else, add and verify your company's domain in Resend (a few DNS records), then set `EMAIL_FROM`, for example `Inventory Count <counts@yourcompany.com>`.

If `RESEND_API_KEY` or `EMAIL_TO` is missing, the Submit button is hidden and the app works as before, with CSV downloads only.

## Run locally

```bash
npm install
cp .env.example .env     # then fill in ANTHROPIC_API_KEY and ACCESS_CODE
npm run dev              # needs Node 20.6 or newer
```

Open http://localhost:3000. The camera button needs HTTPS on a real phone, so test the camera on the Railway domain. Choosing a photo from the library works over plain http.

## Updating the parts list

Edit `parts.json` (an array of `{ "name": "...", "sku": "..." }`) and push. Railway redeploys and every phone picks up the new list on its next load. The server uses this list for counting. The app also loads it behind the scenes to match names and offer autocomplete when a technician adds an item by hand. It is not shown anywhere in the app.

## Checking the parts list loaded

In Railway, open the latest deployment's **Deploy Logs**. You should see `Loaded 182 parts from parts.json`. If you see `WARNING: parts.json was not found`, the file is not at the top level of the repository next to `server.js`. Counting is turned off until it is.

## Notes

- Photos are resized on the phone to 1600 pixels on the long side before upload.
- `GET /healthz` returns `ok` for Railway's health check.
- Rate limiting is in memory, so it resets when the service restarts.
