// api/generate.js — Tìm mẫu phù hợp từ Pinecone → Sinh content

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const PINECONE_KEY  = process.env.PINECONE_API_KEY;
  const PINECONE_HOST = process.env.PINECONE_HOST;

  if (!ANTHROPIC_KEY || !PINECONE_KEY || !PINECONE_HOST) {
    return res.status(500).json({ error: 'Thiếu environment variables' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { kocInfo, link, editRequest } = body;
  if (!kocInfo || !link) return res.status(400).json({ error: 'Thiếu kocInfo hoặc link' });

  // Edit mode - chat feedback
  if (editRequest) {
    try {
      const cur  = (editRequest.currentContent || '').slice(0, 800);
      const fb   = (editRequest.feedback || '').slice(0, 300);
      const hist = (editRequest.history || [])
        .filter(m => !m.loading)
        .map(m => (m.role === 'user' ? 'User: ' : 'AI: ') + (m.text||'').slice(0,150))
        .slice(-4).join('\n');

      const ep = 'Ban la copywriter Viet Nam chuyen Facebook content ve tieng Anh tre em voi Edupia.\n\n'
        + 'BAI HIEN TAI:\n' + cur + '\n\n'
        + 'THONG TIN KOC:\n' + (kocInfo||'').slice(0,200) + '\n\n'
        + (hist ? 'LICH SU:\n' + hist + '\n\n' : '')
        + 'GOP Y MOI:\n' + fb + '\n\n'
        + 'Sua bai theo gop y. Chi nhac Edupia 1 lan. Khong de cap lop/tuoi cu the. Giong phu huynh VN. '
        + 'Viet tieng Viet co dau. Link dang ky: ' + link + '\n\n'
        + 'JSON hop le, khong markdown:\n'
        + '{"versions":[{"label":"Da sua theo gop y","content":"..."},{"label":"Phien ban khac","content":"..."}]}';

      const er = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5000, messages: [{ role: 'user', content: ep }] }),
      });
      if (!er.ok) throw new Error('Claude API ' + er.status + ': ' + (await er.text()).slice(0,150));
      const ed = await er.json();
      if (ed.error) throw new Error(ed.error.message);
      const raw2 = (ed.content||[]).map(b=>b.text||'').join('');
      if (!raw2) throw new Error('Empty response. Stop: ' + ed.stop_reason);
      let p2;
      try {
        const cleaned2 = raw2.replace(/```json|```/g,'').trim();
        p2 = JSON.parse(cleaned2);
      } catch(e) {
        // Nếu JSON lỗi do dấu " trong content, dùng regex extract từng field
        try {
          const labels   = [...raw2.matchAll(/"label"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
          const contents = [...raw2.matchAll(/"content"\s*:\s*"([\s\S]*?)(?=",\s*"label"|"\s*}\s*]|}$)/g)].map(m => m[1]);
          if (labels.length >= 1 && contents.length >= 1) {
            p2 = { versions: labels.map((l, i) => ({ label: l, content: (contents[i]||'').replace(/\\n/g,'\n') })) };
          } else {
            // Fallback: lấy text thô và tạo 1 version
            const textOnly = raw2.replace(/"label"\s*:\s*"[^"]*"\s*,\s*"content"\s*:\s*"/g,'').replace(/["{}[\]]/g,'').trim();
            p2 = { versions: [{ label: 'Da sua theo gop y', content: textOnly.slice(0, 1000) }] };
          }
        } catch(e2) {
          throw new Error('JSON parse fail: ' + raw2.slice(0,200));
        }
      }
      if (!p2?.versions?.length) throw new Error('No versions in response');
      return res.status(200).json({ versions: p2.versions, dnaUsed: { koc: 0, viral: 0 }, topKocScore: 0 });
    } catch(editErr) {
      return res.status(500).json({ error: 'Chat edit error: ' + editErr.message });
    }
  }

  try {
    // ── 1. Tạo embedding từ thông tin KOC ──
    const queryVec = pseudoEmbedding(kocInfo);

    const mode = body.mode || 'first'; // 'first' | 'return'

    // ── 2. Query Pinecone theo mode ──
    let kocMatches = [], viralMatches = [], returnMatches = [];

    if (mode === 'return') {
      // Lần 2+: ưu tiên DNA lần 2, bổ sung thêm DNA lần đầu
      [returnMatches, kocMatches, viralMatches] = await Promise.all([
        queryPinecone(queryVec, 'return', 4, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'koc',    2, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'viral',  1, PINECONE_KEY, PINECONE_HOST),
      ]);
    } else {
      // Lần đầu: DNA KOC + Viral
      [kocMatches, viralMatches] = await Promise.all([
        queryPinecone(queryVec, 'koc',   3, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'viral', 1, PINECONE_KEY, PINECONE_HOST),
      ]);
    }

    // ── 3. Build DNA block ──
    let dnaBlock = '';

    if (mode === 'return' && returnMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA ƯU TIÊN — ${returnMatches.length} MẪU KOC LẦN 2+ ═══\n`;
      dnaBlock += `Học: angle update, kết quả dài hạn, tone tin tưởng.\n`;
      dnaBlock += returnMatches.map((m, i) => {
        const md = m.metadata;
        const contentLen = i === 0 ? 400 : 150;
        const infoLen    = i === 0 ? 120 : 60;
        return `\n[LẦN2-${i+1} | ${(m.score*100).toFixed(0)}%]\n${(md.info||'').slice(0,infoLen)}\n${(md.content||'').slice(0,contentLen)}`;
      }).join('\n');
    }

    if (kocMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA ${mode === 'return' ? 'BỔ SUNG' : 'CHÍNH'} — ${kocMatches.length} MẪU KOC LẦN ĐẦU ═══\n`;
      dnaBlock += `Học: cách mở đầu, cấu trúc cảm xúc, giọng điệu, chi tiết thật, CTA.\n`;
      dnaBlock += kocMatches.map((m, i) => {
        const md = m.metadata;
        // Mẫu đầu tiên (khớp nhất) đưa vào đầy đủ hơn, các mẫu sau chỉ lấy hook
        const contentLen = i === 0 ? 400 : 150;
        const infoLen    = i === 0 ? 120 : 60;
        return `\n[KOC-${i+1} | ${(m.score*100).toFixed(0)}% | ${md.level||''} | ${md.grade||''}]\n${(md.info||'').slice(0,infoLen)}\n${(md.content||'').slice(0,contentLen)}`;
      }).join('\n');
    }

    if (viralMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA VIRAL ═══\n`;
      dnaBlock += viralMatches.map((m, i) => `\n[VIRAL-${i+1}]\n${(m.metadata.content||'').slice(0,200)}`).join('\n');
    }

    if (!dnaBlock) {
      dnaBlock = '\n\n[Chưa có dữ liệu DNA — hệ thống sẽ viết dựa trên kiến thức chung]\n';
    }

    // ── 4. Gọi Claude để viết content ──
    // Build prompt dựa trên mode — tránh nested template literal
    const isReturn = mode === 'return';

    const modeIntro = isReturn
      ? 'Day la bai viet cho KOC da hop tac LAN 2+. Angle va cau truc phai KHAC HOAN TOAN lan dau.'
      : 'Day la bai viet cho KOC hop tac LAN DAU TIEN.';

    const modeRules = isReturn
      ? `CHE DO LAN 2+ — QUY TAC DAC BIET:
- Angle PHAI la "update / sau X thang / ket qua tiep theo" — KHONG duoc viet nhu lan dau kham pha
- Mo dau bang viec de cap da tung chia se truoc day, nay co ket qua moi de update
- Tone tin tuong da duoc xay dung: khong can thuyet phuc nhieu, chi can ke ket qua that
- Nhan manh ket qua DAI HAN, cu the, co the do duoc (diem so, giai thuong, thay doi hanh vi ro rang)
- Cau truc: "Hoi truoc minh ke... → Nay update..." hoac "X thang roi ke tu khi... → gio thi..."
- Da tin dung Edupia roi nen khong can giai thich nhieu ve san pham — tap trung vao ket qua cua con`
      : `QUY TAC MO DAU:
- Cau MO DAU: nghich ly/bat ngo cuc manh — nguoi luot feed phai dung lai
- KHONG mo bang "Con minh..." hay loi chao nham`;

    const modeVersions = isReturn
      ? `2 PHIEN BAN (ca 2 deu theo angle "update lan 2"):
- "Update ket qua": Mo bang "hoi truoc minh da chia se..." → ket qua dai han cu the → CTA nhe nhang. 180-220 tu.
- "Ngan & viral": Mo bang con so hoac thanh tich cu the gay bat ngo → ke nhanh hanh trinh → CTA. 110-140 tu.`
      : `2 PHIEN BAN:
- "Cam xuc & Cau chuyen": Hook nghich ly → ke cau chuyen that chi tiet → ket qua → CTA. 180-220 tu.
- "Viral hook & Ngan gon": Cau dau cuc soc/hai → ke suc tich → CTA manh. 110-140 tu.`;

    const jsonFormat = isReturn
      ? '{"versions":[{"label":"Update ket qua","content":"..."},{"label":"Ngan & viral","content":"..."}]}'
      : '{"versions":[{"label":"Cam xuc & Cau chuyen","content":"..."},{"label":"Viral hook & Ngan gon","content":"..."}]}';

    const prompt = `Ban la chuyen gia copywriter hang dau, chuyen viet Facebook viral cho phu huynh Viet Nam ve hoc tieng Anh tre em voi Edupia — lop nhom nho 1-4 hoc sinh, chat luong cao.
${dnaBlock}

THONG TIN KOC MOI:
${kocInfo}

Link dang ky: ${link}

NHIEM VU:
${modeIntro}
Dua vao DNA ben tren, viet 2 phien ban content Facebook HOAN TOAN KHAC NHAU.

PHAN TICH TRUOC KHI VIET:
- Tu DNA: hoc cach mo dau, giong dieu, chi tiet that phu hop voi chan dung KOC nay
- Tu thong tin KOC: xac dinh ket qua noi bat, angle cau chuyen tot nhat

${modeRules}

QUY TAC CHUNG:
1. Chi nhac "Edupia" dung 1 lan. KHONG dung "Edupia Pro".
2. KHONG de cap lop hoc, tuoi cu the cua con trong bai.
3. Giong phu huynh Viet Nam doi thuong: "minh", "con minh", "be", khong van hoa, khong quang cao lo lieu.
4. Chi tiet that: cau noi cua con, tinh huong cu the, cam xuc that.
5. CTA cuoi: hoc bong giam hoc phi + mien phi buoi hoc thu + app AI luyen noi + hoi thoai thay co nguoi nuoc ngoai. Link: ${link}
6. 3-5 hashtag phu hop. Viet bang tieng Viet co dau day du.
7. QUAN TRONG: Tat ca noi dung phai viet bang TIENG VIET co dau, khong viet tieng Anh phan am.

${modeVersions}

JSON hop le, khong markdown, khong backtick:
${jsonFormat}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 5000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    // Log Claude response status for debugging
    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API lỗi ' + claudeRes.status + ': ' + errText.slice(0, 300));
    }

    const claudeData = await claudeRes.json();

    // Check for API-level errors
    if (claudeData.error) {
      throw new Error('Claude error: ' + claudeData.error.message);
    }

    const raw = (claudeData.content || []).map(b => b.text || '').join('');

    if (!raw) {
      throw new Error('Claude trả về rỗng. Stop reason: ' + claudeData.stop_reason + ' | Usage: ' + JSON.stringify(claudeData.usage));
    }

    // Robust JSON extraction
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch(parseErr) {
      try {
        // Thử extract bằng regex khi có dấu " trong content làm vỡ JSON
        const labels   = [...raw.matchAll(/"label"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
        const contents = [...raw.matchAll(/"content"\s*:\s*"([\s\S]*?)(?=",\s*"label"|"\s*}\s*])/g)].map(m => m[1]);
        if (labels.length >= 1 && contents.length >= 1) {
          parsed = { versions: labels.map((l, i) => ({ label: l, content: (contents[i]||'').replace(/\\n/g,'\n') })) };
        } else {
          throw new Error('Regex extract failed');
        }
      } catch(e2) {
        throw new Error('JSON parse that bai: ' + raw.slice(0, 300));
      }
    }

    if (!parsed?.versions?.length) throw new Error('Thiếu versions. Parsed: ' + JSON.stringify(parsed).slice(0, 200));

    return res.status(200).json({
      versions:    parsed.versions,
      dnaUsed:     { koc: kocMatches.length, viral: viralMatches.length, return: returnMatches.length },
      topKocScore: returnMatches[0]?.score || kocMatches[0]?.score || 0,
      mode,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Query Pinecone ──
async function queryPinecone(vector, namespace, topK, pineconeKey, pineconeHost) {
  const res = await fetch(`${pineconeHost}/query`, {
    method: 'POST',
    headers: {
      'Api-Key':      pineconeKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vector,
      topK,
      namespace,
      includeMetadata: true,
    }),
  });
  if (!res.ok) throw new Error(`Pinecone query error: ${await res.text()}`);
  const json = await res.json();
  return json.matches || [];
}

// Pseudo-embedding (cùng hàm với sync.js để vector space nhất quán)
function pseudoEmbedding(text) {
  const dim = 1024;
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dim]     += Math.sin(code * (i + 1));
    vec[(i*7) % dim] += Math.cos(code * 0.1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0)) || 1;
  return vec.map(v => v / norm);
}
