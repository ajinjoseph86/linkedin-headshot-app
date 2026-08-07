# LinkedIn Headshot

Upload a casual photo and get a polished, professional LinkedIn-style headshot.
Powered by [fal.ai](https://fal.ai)'s GPT Image 2 edit model, same stack and
paywall setup as the Age Transform app.

## 1. Install

```bash
npm install
```

## 2. Add your keys

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `FAL_KEY` — from https://fal.ai/dashboard/keys
- `STRIPE_SECRET_KEY` — from https://dashboard.stripe.com/apikeys (test key while testing)

Never commit `.env` — it's already in `.gitignore`.

## 3. Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

## How it works

1. Upload 1-2 photos of yourself.
2. Pick attire, background, and framing from the dropdowns (no free-text prompt
   needed — the server builds the prompt from your choices).
3. Click **Generate Headshot**. The server sends your photo(s) + the built prompt
   to fal.ai and shows the result with an on-screen watermark.
4. Each visitor gets **5 free headshots** (`MAX_GENERATIONS_PER_CLIENT` in `.env`),
   then must pay `DOWNLOAD_PRICE_USD` (default $2.00) via Stripe Checkout to unlock
   a real, unwatermarked download and continue generating.

## Cost control — daily budget cap

Same guardrail as the Age Transform app: `data/spend.json` tracks cumulative spend
per day (Asia/Singapore time) and the server refuses further fal.ai calls once
`DAILY_BUDGET_USD` (default $10.00) is hit for the day.

## Project structure

```
server.js            Express server + fal.ai + Stripe + budget/history logic
public/index.html     UI markup
public/style.css       Styling (shared dark theme with the other apps)
public/app.js           Frontend logic (upload, style choices, checkout flow)
public/generated/       Saved output images (gitignored)
data/                    spend.json, history.json, paid.json (gitignored, runtime)
```

## Deployment

Same pattern as the Age Transform app: push to GitHub, deploy as a Render Web
Service (Starter plan + persistent disk), set env vars, point a subdomain
(`linkedin.multiversematrix.net`) at it via a CNAME record.
