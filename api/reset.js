// api/reset.js — Xoa sach 1 namespace trong Pinecone de sync lai tu dau
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PINECONE_KEY  = process.env.PINECONE_API_KEY;
  const PINECONE_HOST = process.env.PINECONE_HOST;
  if (!PINECONE_KEY || !PINECONE_HOST) {
    return res.status(500).json({ error: 'Thieu PINECONE_API_KEY hoac PINECONE_HOST' });
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch(e) {}

  const namespace = body.namespace || 'return';

  try {
    const r = await fetch(`${PINECONE_HOST}/vectors/delete`, {
      method: 'POST',
      headers: { 'Api-Key': PINECONE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteAll: true, namespace }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(JSON.stringify(json));
    return res.status(200).json({ success: true, message: `Da xoa namespace "${namespace}"` });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
