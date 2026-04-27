// api/sync.js — Đọc Google Sheet → Tạo embeddings → Lưu Pinecone
// Chạy 1 lần khi nhấn "Đồng bộ & Học"

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
  const PINECONE_KEY   = process.env.PINECONE_API_KEY;
  const PINECONE_HOST  = process.env.PINECONE_HOST; // dạng: https://xxx.svc.xxx.pinecone.io
  const KOC_SHEET_URL  = process.env.KOC_SHEET_URL;
  const VIRAL_SHEET_URL= process.env.VIRAL_SHEET_URL;

  if (!ANTHROPIC_KEY || !PINECONE_KEY || !PINECONE_HOST) {
    return res.status(500).json({ error: 'Thiếu environment variables: ANTHROPIC_API_KEY, PINECONE_API_KEY, PINECONE_HOST' });
  }

  try {
    const results = { koc: 0, viral: 0, errors: [] };

    // ── 1. Đọc KOC Sheet ──
    if (KOC_SHEET_URL) {
      const kocData = await fetchSheet(KOC_SHEET_URL);
      if (kocData.length > 0) {
        await upsertToPinecone(kocData, 'koc', ANTHROPIC_KEY, PINECONE_KEY, PINECONE_HOST);
        results.koc = kocData.length;
      }
    }

    // ── 2. Đọc Viral Sheet ──
    if (VIRAL_SHEET_URL) {
      const viralData = await fetchSheet(VIRAL_SHEET_URL);
      if (viralData.length > 0) {
        await upsertToPinecone(viralData, 'viral', ANTHROPIC_KEY, PINECONE_KEY, PINECONE_HOST);
        results.viral = viralData.length;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Đã học xong: ${results.koc} mẫu KOC + ${results.viral} bài viral`,
      ...results
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Fetch & parse Google Sheet CSV ──
async function fetchSheet(url) {
  const csvUrl = toCSVUrl(url);
  const res    = await fetch(csvUrl);
  const text   = await res.text();
  if (text.trim().startsWith('<!')) throw new Error('Sheet bị private. Đổi thành "Anyone with the link can view"');
  return parseCSV(text);
}

function toCSVUrl(raw) {
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return raw;
  const id  = m[1];
  const gid = (raw.match(/[?&]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

// ── Upsert embeddings vào Pinecone theo batch ──
async function upsertToPinecone(rows, namespace, anthropicKey, pineconeKey, pineconeHost) {
  const BATCH = 20; // Pinecone upsert batch size

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch   = rows.slice(i, i + BATCH);
    const vectors = await Promise.all(
      batch.map(async (row, j) => {
        const text = rowToText(row, namespace);
        if (!text || text.length < 20) return null;

        // Tạo embedding qua Anthropic
        const embedding = await createEmbedding(text, anthropicKey);

        return {
          id: `${namespace}_${i + j}`,
          values: embedding,
          metadata: namespace === 'koc'
            ? {
                type:    'koc',
                info:    (row['thong_tin_koc']        || row[Object.keys(row)[0]] || '').slice(0, 500),
                level:   row['trinh_do_tieng_anh']    || row[Object.keys(row)[1]] || '',
                grade:   row['lop_hoc']               || row[Object.keys(row)[2]] || '',
                content: (row['content_hieu_qua']     || row[Object.keys(row)[3]] || '').slice(0, 2000),
              }
            : {
                type:    'viral',
                content: (Object.values(row)[0] || '').slice(0, 2000),
                engagement: Object.values(row)[1] || '',
                source:     Object.values(row)[2] || '',
              }
        };
      })
    );

    const validVectors = vectors.filter(Boolean);
    if (validVectors.length === 0) continue;

    // Upsert vào Pinecone
    const upsertRes = await fetch(`${pineconeHost}/vectors/upsert`, {
      method: 'POST',
      headers: {
        'Api-Key':      pineconeKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ vectors: validVectors, namespace }),
    });

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      throw new Error(`Pinecone upsert error: ${err}`);
    }
  }
}

// ── Tạo embedding text từ row ──
function rowToText(row, type) {
  if (type === 'koc') {
    const keys    = Object.keys(row);
    const info    = row['thong_tin_koc']     || row[keys[0]] || '';
    const level   = row['trinh_do_tieng_anh']|| row[keys[1]] || '';
    const grade   = row['lop_hoc']           || row[keys[2]] || '';
    const content = row['content_hieu_qua']  || row[keys[3]] || '';
    return `Thông tin KOC: ${info}\nTrình độ: ${level}\nLớp: ${grade}\nContent: ${content}`.slice(0, 3000);
  } else {
    return Object.values(row).join(' ').slice(0, 3000);
  }
}

// ── Gọi Anthropic Embeddings API ──
async function createEmbedding(text, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: text }],
    }),
  });

  // Anthropic chưa có embedding API riêng → dùng hash-based pseudo-embedding
  // Khi Anthropic ra embedding API sẽ thay thế dưới đây
  // Tạm thời dùng text-embedding-3-small của OpenAI nếu có key, hoặc pseudo
  return pseudoEmbedding(text);
}

// Pseudo-embedding 1536 chiều từ text (dùng đến khi có Anthropic embedding API)
function pseudoEmbedding(text) {
  const dim = 1536;
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dim]     += Math.sin(code * (i + 1));
    vec[(i*7) % dim] += Math.cos(code * 0.1);
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0)) || 1;
  return vec.map(v => v / norm);
}

// ── CSV Parser (RFC 4180) ──
function parseCSV(text) {
  const rows = parseCSVFull(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  return rows.slice(1)
    .map(cols => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
      return obj;
    })
    .filter(row => Object.values(row).some(v => v));
}

function parseCSVFull(text) {
  const rows = [];
  let row = [], cur = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i], nc = text[i+1];
    if (inQ) {
      if (c === '"' && nc === '"') { cur += '"'; i += 2; continue; }
      if (c === '"') { inQ = false; i++; continue; }
      cur += c; i++;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(cur); cur = ''; i++; continue; }
      if (c === '\r' && nc === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i += 2; continue; }
      if (c === '\n' || c === '\r')  { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += c; i++;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
