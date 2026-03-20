const express = require('express');
const cors    = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  process.env.WEB_ORIGIN,
  'http://localhost:5173',
  'http://localhost:3000',
  'https://jobpilot.prathi.tech',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true
}));
app.options('*', cors());

// ── ENV ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(Boolean);

const ADZUNA_APP_ID  = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const ADZUNA_COUNTRY = process.env.ADZUNA_COUNTRY || 'in';
const PLACES_KEY     = process.env.GOOGLE_PLACES_API_KEY;
const SUPABASE_URL   = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── SUPABASE ──────────────────────────────────────────────────
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const sb = require('@supabase/supabase-js');
    supabase = sb.createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch(e) {}
}

// ── GEMINI ROTATION ───────────────────────────────────────────
let gIdx = 0;
async function callGemini(prompt) {
  const tries = GEMINI_KEYS.length || 1;
  for (let i = 0; i < tries; i++) {
    const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.7,maxOutputTokens:2048} }) }
      );
      const d = await res.json();
      if (d.candidates?.[0]?.content?.parts?.[0]?.text) return d.candidates[0].content.parts[0].text;
      if (d.error?.code === 429) continue;
      throw new Error(d.error?.message || 'Gemini error');
    } catch(e) { if(i===tries-1) throw e; }
  }
  throw new Error('All Gemini keys exhausted');
}

// ══════════════════════════════════════════════════════════════
app.get('/', (_, res) => res.json({ status:'JobPilot API ✅', version:'1.0.0' }));
app.get('/health', (_, res) => res.json({ status:'ok', geminiKeys:GEMINI_KEYS.length, supabase:!!supabase, adzuna:!!ADZUNA_APP_ID }));

// ── GSI Token Verify ──────────────────────────────────────────
app.post('/auth/google-gsi', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error:'Missing idToken' });
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    const p = await r.json();
    if (p.error) return res.status(400).json({ error:p.error });
    const user = { id:p.sub, email:p.email, name:p.name, avatar:p.picture };
    if (supabase) {
      await supabase.from('users').upsert({ google_id:user.id, email:user.email, name:user.name, avatar:user.avatar, updated_at:new Date().toISOString() }, { onConflict:'google_id' });
    }
    res.json({ user, verified:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Gmail Job Emails ──────────────────────────────────────────
app.post('/gmail/job-emails', async (req, res) => {
  try {
    const { accessToken } = req.body;
    const q = encodeURIComponent('subject:(interview OR application OR offer OR hiring OR shortlisted) newer_than:30d');
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`, { headers:{ Authorization:`Bearer ${accessToken}` } });
    const list = await listRes.json();
    if (!list.messages) return res.json({ emails:[] });
    const emails = await Promise.all(list.messages.slice(0,10).map(async m => {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers:{ Authorization:`Bearer ${accessToken}` } });
      const msg = await msgRes.json();
      const h = msg.payload?.headers || [];
      const get = n => h.find(x=>x.name===n)?.value || '';
      return { id:m.id, from:get('From'), subject:get('Subject'), date:get('Date'), snippet:msg.snippet, read:!msg.labelIds?.includes('UNREAD') };
    }));
    res.json({ emails });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/gmail/send', async (req, res) => {
  try {
    const { accessToken, to, subject, body } = req.body;
    const raw = Buffer.from(`To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`)
      .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method:'POST', headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ raw })
    });
    const d = await r.json();
    res.json({ success:!d.error, messageId:d.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Job Search ────────────────────────────────────────────────
app.get('/jobs/search', async (req, res) => {
  try {
    const { q='developer', location='', page=1, results_per_page=12, full_time=0, part_time=0 } = req.query;
    let url = `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/${page}?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&results_per_page=${results_per_page}&what=${encodeURIComponent(q)}&sort_by=date`;
    if (location) url += `&where=${encodeURIComponent(location)}`;
    if (full_time==1) url += `&full_time=1`;
    if (part_time==1) url += `&part_time=1`;
    const r = await fetch(url);
    const d = await r.json();
    const jobs = (d.results||[]).map(j => ({
      id:j.id, title:j.title,
      company: j.company?.display_name||'Unknown',
      location: j.location?.display_name||'',
      salary: (j.salary_min&&j.salary_max) ? `₹${Math.round(j.salary_min/100000)}–${Math.round(j.salary_max/100000)} LPA` : 'Competitive',
      description: j.description||'', applyUrl:j.redirect_url,
      category: j.category?.label||'', partTime: j.contract_type==='part_time'
    }));
    res.json({ jobs, count:d.count||0, page:parseInt(page) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/jobs/parttime', async (req, res) => {
  try {
    const { q='developer', location='Chennai', radius=25 } = req.query;
    const url = `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&results_per_page=12&part_time=1&what=${encodeURIComponent(q)}&where=${encodeURIComponent(location)}&distance=${radius}`;
    const r = await fetch(url);
    const d = await r.json();
    const jobs = (d.results||[]).map(j => ({
      id:j.id, title:j.title,
      company: j.company?.display_name||'Unknown',
      location: j.location?.display_name||location,
      pay: j.salary_min ? `₹${Math.round(j.salary_min/12/1000)}k/mo` : 'Negotiable',
      applyUrl: j.redirect_url,
      description: (j.description||'').slice(0,150)+'...'
    }));
    res.json({ jobs });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Nearby Companies ──────────────────────────────────────────
app.get('/companies/nearby', async (req, res) => {
  try {
    const { lat, lng, radius=25000, type='IT company' } = req.query;
    if (!lat||!lng) return res.status(400).json({ error:'lat/lng required' });
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(type)}&type=establishment&key=${PLACES_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const companies = (d.results||[]).slice(0,12).map(p => ({
      id:p.place_id, name:p.name, address:p.vicinity, rating:p.rating,
      types:(p.types||[]).filter(t=>t!=='point_of_interest'&&t!=='establishment').slice(0,2)
    }));
    res.json({ companies });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/companies/details/:placeId', async (req, res) => {
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${req.params.placeId}&fields=name,website,formatted_phone_number&key=${PLACES_KEY}`);
    const d = await r.json();
    res.json(d.result||{});
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── AI Resume ─────────────────────────────────────────────────
app.post('/ai/resume', async (req, res) => {
  try {
    const { name, role, skills, experience, jobDescription, education, location } = req.body;
    const prompt = `You are an ATS resume expert. Create resume for:
Name:${name}, Role:${role}, Skills:${skills}, Exp:${experience}, Location:${location||'India'}, Education:${education||'B.Tech'}
Job:${jobDescription||'General '+role}
Rules: Fresher=1 page, Senior=max 2 pages. Strong action verbs. ATS optimized.
Return ONLY valid JSON: {"resumeHTML":"<div style='font-family:sans-serif;color:#111;padding:20px;max-width:700px'>...full resume...</div>","atsScore":92,"missingSkills":["Docker"],"suggestions":["Add GitHub"]}`;
    const text = await callGemini(prompt);
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    try { res.json(JSON.parse(clean)); }
    catch(e) { res.json({ resumeHTML:'<pre style="white-space:pre-wrap">'+text+'</pre>', atsScore:80, missingSkills:[], suggestions:[] }); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── AI Email ──────────────────────────────────────────────────
app.post('/ai/email', async (req, res) => {
  try {
    const { name, role, company, jobTitle, skills, experience, tone='professional' } = req.body;
    const prompt = `Write a ${tone} job application email.
Applicant:${name}, Role:${jobTitle} at ${company}, Skills:${skills}, Exp:${experience}
Return ONLY valid JSON: {"subject":"Application for ${jobTitle} – ${name}","body":"email body max 200 words","followUpSubject":"Following up","followUpBody":"short follow up"}`;
    const text = await callGemini(prompt);
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    try { res.json(JSON.parse(clean)); }
    catch(e) { res.json({ subject:`Application for ${jobTitle} – ${name}`, body:text, followUpBody:'' }); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── AI Match ──────────────────────────────────────────────────
app.post('/ai/match', async (req, res) => {
  try {
    const { jobDescription, userSkills, userRole, experience } = req.body;
    const prompt = `Job match analysis. User:${userRole}, Skills:${userSkills}, Exp:${experience}. Job:${(jobDescription||'').slice(0,500)}
Return ONLY valid JSON: {"score":87,"matchedSkills":["React"],"missingSkills":["Docker"],"verdict":"Strong Match","tips":["Highlight React"]}`;
    const text = await callGemini(prompt);
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    try { res.json(JSON.parse(clean)); }
    catch(e) { res.json({ score:80, matchedSkills:[], missingSkills:[], verdict:'Good Match', tips:[] }); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Profile / Applied Jobs ────────────────────────────────────
app.post('/profile/save', async (req, res) => {
  if (!supabase) return res.json({ success:true });
  try {
    const { userId, ...profile } = req.body;
    await supabase.from('profiles').upsert({ user_id:userId, ...profile, updated_at:new Date().toISOString() }, { onConflict:'user_id' });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/profile/:userId', async (req, res) => {
  if (!supabase) return res.json({ profile:null });
  try {
    const { data } = await supabase.from('profiles').select('*').eq('user_id',req.params.userId).single();
    res.json({ profile:data });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/jobs/applied/save', async (req, res) => {
  if (!supabase) return res.json({ success:true });
  try {
    const { userId, job } = req.body;
    await supabase.from('applied_jobs').insert({ user_id:userId, ...job, applied_at:new Date().toISOString() });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/jobs/applied/:userId', async (req, res) => {
  if (!supabase) return res.json({ jobs:[] });
  try {
    const { data } = await supabase.from('applied_jobs').select('*').eq('user_id',req.params.userId).order('applied_at',{ascending:false});
    res.json({ jobs:data||[] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Automation ────────────────────────────────────────────────
const autoSessions = new Map();
app.post('/automation/start', (req,res) => {
  const { userId, profile, tokens } = req.body;
  autoSessions.set(userId, { profile, tokens, active:true, startedAt:new Date() });
  res.json({ success:true });
});
app.post('/automation/stop', (req,res) => {
  if (autoSessions.has(req.body.userId)) autoSessions.get(req.body.userId).active = false;
  res.json({ success:true });
});
app.get('/automation/status/:userId', (req,res) => {
  const s = autoSessions.get(req.params.userId);
  res.json({ active:s?.active||false, startedAt:s?.startedAt||null });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 JobPilot API on port ${PORT}`);
  console.log(`   Gemini: ${GEMINI_KEYS.length} keys | Adzuna: ${ADZUNA_APP_ID?'✅':'❌'} | Places: ${PLACES_KEY?'✅':'❌'}\n`);
});