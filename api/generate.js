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

  // ── Chế độ sửa bài theo góp ý chat ──
  if (editRequest) {
    const { currentContent, feedback, history } = editRequest;
    const historyTxt = (history || [])
      .map(m => (m.role === 'user' ? 'Người dùng: ' : 'AI: ') + m.text)
      .join('\n');

    const editPrompt = `Bạn là copywriter chuyên viết Facebook content cho phụ huynh Việt Nam về học tiếng Anh với Edupia.

BÀI VIẾT HIỆN TẠI:
${currentContent}

THÔNG TIN KOC:
${kocInfo}

LỊCH SỬ GÓP Ý:
${historyTxt || 'Chưa có'}

GÓP Ý MỚI NHẤT CỦA NGƯỜI DÙNG:
${feedback}

NHIỆM VỤ: Sửa lại bài viết theo đúng góp ý. Giữ nguyên những gì tốt, chỉ thay đổi theo yêu cầu.
Quy tắc: Chỉ nhắc "Edupia" 1 lần. Không đề cập lớp/tuổi. Giọng phụ huynh VN. Link: ${link}

Trả về JSON: {"versions":[{"label":"Đã chỉnh theo góp ý","content":"..."},{"label":"Phiên bản thay thế","content":"..."}]}`;

    const editRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: editPrompt }] }),
    });
    const editData = await editRes.json();
    if (!editRes.ok || editData.error) throw new Error(editData.error?.message || 'Claude edit error');
    const raw = (editData.content || []).map(b => b.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim()); }
    catch(e) { const m = raw.match(/\{[\s\S]*"versions"[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed?.versions) throw new Error('Không parse được response');
    return res.status(200).json({ versions: parsed.versions, dnaUsed: { koc: 0, viral: 0 }, topKocScore: 0 });
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
        queryPinecone(queryVec, 'return', 5, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'koc',    3, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'viral',  2, PINECONE_KEY, PINECONE_HOST),
      ]);
    } else {
      // Lần đầu: DNA KOC + Viral
      [kocMatches, viralMatches] = await Promise.all([
        queryPinecone(queryVec, 'koc',   5, PINECONE_KEY, PINECONE_HOST),
        queryPinecone(queryVec, 'viral', 3, PINECONE_KEY, PINECONE_HOST),
      ]);
    }

    // ── 3. Build DNA block ──
    let dnaBlock = '';

    if (mode === 'return' && returnMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA ƯU TIÊN — ${returnMatches.length} MẪU CONTENT KOC LẦN 2+ ═══\n`;
      dnaBlock += `Đây là content của những KOC đã hợp tác lần 2+. Học kỹ phong cách, cách đề cập kết quả dài hạn, sự tin tưởng đã được xây dựng.\n`;
      dnaBlock += returnMatches.map((m, i) => {
        const md = m.metadata;
        return `\n[LẦN2-${i+1} | Score: ${(m.score*100).toFixed(0)}% | ${md.level||''} | ${md.grade||''}]\nThông tin KOC: ${(md.info||'').slice(0,150)}\nContent:\n${(md.content||'').slice(0,500)}`;
      }).join('\n');
    }

    if (kocMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA ${mode === 'return' ? 'BỔ SUNG' : 'CHÍNH'} — ${kocMatches.length} MẪU KOC LẦN ĐẦU ═══\n`;
      dnaBlock += `Học: cách mở đầu, cấu trúc cảm xúc, giọng điệu, chi tiết thật, CTA.\n`;
      dnaBlock += kocMatches.map((m, i) => {
        const md = m.metadata;
        return `\n[KOC-${i+1} | Score: ${(m.score*100).toFixed(0)}% | ${md.level||'—'} | ${md.grade||'—'}]\nThông tin KOC: ${(md.info||'').slice(0,150)}\nContent:\n${(md.content||'').slice(0,500)}`;
      }).join('\n');
    }

    if (viralMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA VIRAL — ${viralMatches.length} BÀI FACEBOOK PHÙ HỢP ═══\n`;
      dnaBlock += `Học: hook mở đầu, cấu trúc thu hút, yếu tố tạo share.\n`;
      dnaBlock += viralMatches.map((m, i) => `\n[VIRAL-${i+1} | Score: ${(m.score*100).toFixed(0)}%]\n${(m.metadata.content||'').slice(0,400)}`).join('\n');
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
        max_tokens: 4000,
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
      const match = raw.match(/\{[\s\S]*"versions"[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch(e2) { throw new Error('JSON parse thất bại: ' + raw.slice(0, 300)); }
      } else {
        throw new Error('Format JSON sai. Raw response: ' + raw.slice(0, 300));
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
