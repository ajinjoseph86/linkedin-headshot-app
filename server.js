require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FAL_KEY = process.env.FAL_KEY;
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');
const MAX_GENERATIONS_PER_CLIENT = parseInt(process.env.MAX_GENERATIONS_PER_CLIENT || '5', 10);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// GPT Image 2 edit, low quality for the free preview ($/image, worst-case for non-square sizes).
// See https://fal.ai/models/fal-ai/gpt-image-2/edit
const COST_PER_IMAGE_USD = 0.013;
const FAL_MODEL = 'openai/gpt-image-2/edit';
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'low';

// Paid download resolution tiers: price the customer pays, and the fal.ai
// quality/size used to re-render the saved preview at that resolution.
// estimatedCostUsd is a conservative (worst-case) fal.ai cost used for the
// daily budget guard — see https://fal.ai/models/fal-ai/gpt-image-2/edit for pricing.
const RESOLUTION_TIERS = {
  '1k': { priceUsd: 2.0, width: 1024, height: 1024, quality: 'medium', estimatedCostUsd: 0.07, label: '1K' },
  '2k': { priceUsd: 4.0, width: 2048, height: 2048, quality: 'high', estimatedCostUsd: 0.3, label: '2K' },
  '4k': { priceUsd: 5.0, width: 4096, height: 4096, quality: 'high', estimatedCostUsd: 0.9, label: '4K' },
};

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PAID_FILE = path.join(DATA_DIR, 'paid.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');

for (const dir of [DATA_DIR, GENERATED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

// ---------- per-visitor client id (so each browser only sees its own gallery) ----------

const CLIENT_COOKIE = 'linkedin_client_id';

function getClientId(req, res) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  if (match) return match[1];

  const id = uuidv4();
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`
  );
  return id;
}

app.use((req, res, next) => {
  req.clientId = getClientId(req, res);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 3 },
});

// ---------- date / budget helpers (Asia/Singapore) ----------

function todayKeySGT() {
  // en-CA gives YYYY-MM-DD format
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getTodaySpend() {
  const spend = await readJson(SPEND_FILE, {});
  return spend[todayKeySGT()] || 0;
}

async function addSpend(amount) {
  const spend = await readJson(SPEND_FILE, {});
  const key = todayKeySGT();
  spend[key] = (spend[key] || 0) + amount;
  await writeJson(SPEND_FILE, spend);
  return spend[key];
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_FILE, []);
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200)); // keep last 200
  return history;
}

// ---------- paid downloads ----------

async function findPaidRecord(imageId, tier, clientId) {
  const paid = await readJson(PAID_FILE, []);
  return paid.find((p) => p.imageId === imageId && p.tier === tier && p.clientId === clientId);
}

async function markPaid({ imageId, tier, clientId, sessionId, resultFile }) {
  const paid = await readJson(PAID_FILE, []);
  const existing = paid.find((p) => p.sessionId === sessionId);
  if (existing) return existing; // already recorded
  const record = { imageId, tier, clientId, sessionId, resultFile, paidAt: new Date().toISOString() };
  paid.push(record);
  await writeJson(PAID_FILE, paid);
  return record;
}

// ---------- fal.ai helpers ----------

async function falSubmit(input) {
  const res = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.detail ? JSON.stringify(body.detail) : `fal submit failed (${res.status})`);
  }
  return body; // { request_id, status_url, response_url, ... }
}

async function falPollResult(statusUrl, responseUrl, { timeoutMs = 90000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${FAL_KEY}` },
    });
    const status = await statusRes.json();
    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(responseUrl, {
        headers: { Authorization: `Key ${FAL_KEY}` },
      });
      if (!resultRes.ok) {
        throw new Error(`fal result fetch failed (${resultRes.status})`);
      }
      return resultRes.json();
    }
    if (status.status === 'ERROR' || status.status === 'FAILED') {
      throw new Error(`fal generation failed: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('fal generation timed out');
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download result image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

async function fileToDataUri(filePath) {
  const buf = await fsp.readFile(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// ---------- prompt building ----------
// The user picks from these; the server turns the choices into the prompt.

const ATTIRE = {
  suit: 'a well-tailored dark business suit with a crisp white shirt and a simple tie',
  blazer: 'a smart blazer over a plain shirt, no tie, business-professional',
  shirt: 'a clean, well-pressed collared button-down shirt, business casual',
  knit: 'a smart fine-knit sweater or turtleneck, modern business casual',
};

const BACKGROUND = {
  studio_grey: 'a plain, evenly lit neutral grey photography studio backdrop',
  studio_white: 'a clean soft-white studio backdrop with gentle falloff',
  office: 'a modern bright office interior, softly blurred well behind the subject (shallow depth of field)',
  bookshelf: 'a tasteful bookshelf, softly blurred well behind the subject (shallow depth of field)',
  outdoor: 'a bright outdoor city or campus setting, strongly blurred behind the subject (shallow depth of field)',
};

const FRAMING = {
  head_shoulders: 'Frame it as a classic head-and-shoulders corporate headshot, subject centred, looking directly at the camera.',
  upper_body: 'Frame it from roughly the waist up, subject centred, looking directly at the camera.',
};

function buildPrompt({ attire, background, framing, notes, hasStyleReference }) {
  let prompt =
    'Turn the reference photo(s) of this person into a polished, professional LinkedIn profile headshot. ' +
    'CRITICAL: keep the exact same person — preserve their facial structure, bone structure, eye shape and colour, ' +
    'nose, mouth, skin tone, ethnicity, gender, apparent age, and any distinctive features such as glasses, ' +
    'facial hair, moles or scars. The result must be instantly recognisable as the same individual. ' +
    'Do not beautify, slim, lighten, or otherwise alter their face.';

  if (hasStyleReference) {
    prompt +=
      ' The LAST reference image is a STYLE SAMPLE ONLY, showing a desired headshot look — match its clothing ' +
      'style, background/setting, lighting mood, and framing. Do NOT use any facial features, identity, body ' +
      'shape, skin tone, or hair from that style-sample image; the final person must be based entirely on the ' +
      "other reference photo(s) of the actual subject. If the style sample's clothing or setting conflicts with " +
      'the options below, follow the style sample.';
  }

  prompt += ` Dress the subject in ${ATTIRE[attire] || ATTIRE.blazer}.`;
  prompt += ` Place them against ${BACKGROUND[background] || BACKGROUND.studio_grey}.`;
  prompt += ` ${FRAMING[framing] || FRAMING.head_shoulders}`;

  prompt +=
    ' Use flattering, soft, professional studio lighting with a natural catchlight in the eyes, ' +
    'neutral white balance, and a friendly, approachable, confident closed-mouth smile. ' +
    'Tidy the hair neatly. Sharp focus on the eyes. ' +
    'Photorealistic, high-end corporate photography look. No text, watermarks, logos, or borders.';

  if (notes && notes.trim()) {
    prompt += ` Additional preferences: ${notes.trim()}.`;
  }
  return prompt;
}

// ---------- routes ----------

app.get('/api/budget', async (req, res) => {
  const spent = await getTodaySpend();
  res.json({
    date: todayKeySGT(),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, DAILY_BUDGET_USD - spent).toFixed(4)),
    costPerGenerationUsd: COST_PER_IMAGE_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  res.json(history.filter((entry) => entry.clientId === req.clientId));
});

// ---------- paywall ----------

app.post('/api/checkout', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY. Add it to .env and restart.' });
  }

  const { imageId, tier } = req.body;
  if (!imageId || !tier) {
    return res.status(400).json({ error: 'imageId and tier are required.' });
  }
  const tierConfig = RESOLUTION_TIERS[tier];
  if (!tierConfig) {
    return res.status(400).json({ error: 'Unknown resolution tier.' });
  }

  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === imageId && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Image not found for this session.' });
  }

  if (await findPaidRecord(imageId, tier, req.clientId)) {
    return res.json({ alreadyPaid: true });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(tierConfig.priceUsd * 100),
          product_data: { name: `LinkedIn Headshot — ${tierConfig.label} Download` },
        },
        quantity: 1,
      },
    ],
    metadata: { imageId, tier, clientId: req.clientId },
    success_url: `${origin}/?paid_image=${imageId}&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
  });

  res.json({ url: session.url });
});

app.get('/api/verify-payment', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY.' });
  }
  const { session_id: sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return res.status(402).json({ paid: false });
  }
  if (session.metadata?.clientId !== req.clientId) {
    return res.status(403).json({ error: 'Session does not belong to this browser.' });
  }

  const { imageId, tier } = session.metadata;
  const tierConfig = RESOLUTION_TIERS[tier];
  if (!tierConfig) {
    return res.status(400).json({ error: 'Unknown resolution tier on this session.' });
  }

  const existing = await findPaidRecord(imageId, tier, req.clientId);
  if (existing?.resultFile) {
    return res.json({ paid: true, imageId, tier });
  }

  try {
    const history = await readJson(HISTORY_FILE, []);
    const entry = history.find((h) => h.id === imageId && h.clientId === req.clientId);
    if (!entry) {
      return res.status(404).json({ error: 'Original image not found.' });
    }

    const spentToday = await getTodaySpend();
    if (spentToday + tierConfig.estimatedCostUsd > DAILY_BUDGET_USD) {
      return res.status(429).json({
        error: `Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached, can't render this download right now. ` +
          `Your payment was still successful — contact support for a manual delivery.`,
      });
    }

    const sourceDataUri = await fileToDataUri(path.join(GENERATED_DIR, `${imageId}.png`));

    const submitted = await falSubmit({
      prompt:
        'This is a resolution upscale request. Reproduce this exact image with no changes to content, ' +
        'composition, subject, colours, or style — only render it at the higher target resolution with ' +
        'crisp, enhanced detail and clarity.',
      image_urls: [sourceDataUri],
      num_images: 1,
      image_size: { width: tierConfig.width, height: tierConfig.height },
      quality: tierConfig.quality,
      output_format: 'png',
    });

    const result = await falPollResult(submitted.status_url, submitted.response_url);
    const outputImage = result?.images?.[0];
    if (!outputImage?.url) {
      throw new Error('fal.ai response did not include an output image.');
    }

    const resultFile = `${imageId}-${tier}.png`;
    await downloadToFile(outputImage.url, path.join(GENERATED_DIR, resultFile));
    await addSpend(tierConfig.estimatedCostUsd);
    await markPaid({ imageId, tier, clientId: req.clientId, sessionId, resultFile });

    res.json({ paid: true, imageId, tier });
  } catch (err) {
    console.error('verify-payment render error:', err);
    res.status(500).json({
      error: 'Payment succeeded but rendering the download failed. Contact support for a manual delivery.',
    });
  }
});

app.get('/api/download/:imageId/:tier', async (req, res) => {
  const { imageId, tier } = req.params;
  const record = await findPaidRecord(imageId, tier, req.clientId);
  if (!record || !record.resultFile) {
    return res.status(402).json({ error: 'Payment required.' });
  }
  res.download(
    path.join(GENERATED_DIR, record.resultFile),
    `linkedin-headshot-${imageId.slice(0, 8)}-${tier}.png`
  );
});

app.post(
  '/api/generate',
  upload.fields([
    { name: 'photos', maxCount: 2 },
    { name: 'styleReference', maxCount: 1 },
  ]),
  async (req, res) => {
  try {
    if (!FAL_KEY) {
      return res.status(500).json({ error: 'Server is missing FAL_KEY. Add it to your .env file and restart.' });
    }

    const files = req.files?.photos || [];
    const styleReferenceFile = req.files?.styleReference?.[0] || null;
    if (files.length < 1) {
      return res.status(400).json({ error: 'Upload at least 1 photo of yourself.' });
    }

    const attire = req.body.attire || 'blazer';
    const background = req.body.background || 'studio_grey';
    const framing = req.body.framing || 'head_shoulders';
    const notes = req.body.notes || '';

    if (!ATTIRE[attire]) {
      return res.status(400).json({ error: 'Unknown attire option.' });
    }
    if (!BACKGROUND[background]) {
      return res.status(400).json({ error: 'Unknown background option.' });
    }
    if (!FRAMING[framing]) {
      return res.status(400).json({ error: 'Unknown framing option.' });
    }

    // ---- per-visitor generation cap: after the free limit, require at least 1 paid download ----
    const history = await readJson(HISTORY_FILE, []);
    const clientGenerationCount = history.filter((entry) => entry.clientId === req.clientId).length;
    if (clientGenerationCount >= MAX_GENERATIONS_PER_CLIENT) {
      const paid = await readJson(PAID_FILE, []);
      const hasPaid = paid.some((p) => p.clientId === req.clientId);
      if (!hasPaid) {
        return res.status(402).json({
          error: `You've used your ${MAX_GENERATIONS_PER_CLIENT} free headshots. Pay to download one to keep going.`,
        });
      }
    }

    // ---- budget check BEFORE spending anything ----
    const estimatedCost = COST_PER_IMAGE_USD; // 1 output image per generation
    const spentToday = await getTodaySpend();
    if (spentToday + estimatedCost > DAILY_BUDGET_USD) {
      return res.status(429).json({
        error: `Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. ` +
          `Spent $${spentToday.toFixed(2)} today. Try again after midnight (Asia/Singapore).`,
      });
    }

    // ---- resize + base64-encode photos as data URIs (avoids needing a fal storage upload step) ----
    // Style reference goes LAST in the array so it lines up with the "LAST reference image" wording in the prompt.
    const allFiles = styleReferenceFile ? [...files, styleReferenceFile] : files;
    const imageDataUris = await Promise.all(
      allFiles.map(async (f) => {
        const resized = await sharp(f.buffer)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        return `data:image/jpeg;base64,${resized.toString('base64')}`;
      })
    );

    const prompt = buildPrompt({ attire, background, framing, notes, hasStyleReference: !!styleReferenceFile });

    const submitted = await falSubmit({
      prompt,
      image_urls: imageDataUris,
      num_images: 1,
      image_size: 'square_hd', // LinkedIn crops profile photos to a circle/square
      quality: IMAGE_QUALITY,
      output_format: 'png',
    });

    const result = await falPollResult(submitted.status_url, submitted.response_url);

    const outputImage = result?.images?.[0];
    if (!outputImage?.url) {
      throw new Error('fal.ai response did not include an output image.');
    }

    const id = uuidv4();
    const destFile = `${id}.png`;
    await downloadToFile(outputImage.url, path.join(GENERATED_DIR, destFile));

    const newTotal = await addSpend(estimatedCost);

    const entry = {
      id,
      clientId: req.clientId,
      createdAt: new Date().toISOString(),
      attire,
      background,
      framing,
      notes: notes || null,
      hasStyleReference: !!styleReferenceFile,
      resultUrl: `/generated/${destFile}`,
      costUsd: estimatedCost,
    };
    await appendHistory(entry);

    res.json({
      success: true,
      id: entry.id,
      resultUrl: entry.resultUrl,
      costUsd: estimatedCost,
      spentTodayUsd: Number(newTotal.toFixed(4)),
      remainingTodayUsd: Number(Math.max(0, DAILY_BUDGET_USD - newTotal).toFixed(4)),
    });
  } catch (err) {
    console.error('generate error:', err);
    res.status(500).json({ error: err.message || 'Headshot generation failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`LinkedIn Headshot app running at http://localhost:${PORT}`);
  if (!FAL_KEY) {
    console.warn('WARNING: FAL_KEY is not set. Copy .env.example to .env and add your fal.ai API key.');
  }
});
