#!/usr/bin/env node
// cedric-wake：定时醒来 → 读自己的记忆（心潮）→ 自己决定要不要说话 → Bark 推到她手机
// 没有人设文件。醒来的是谁、她是谁，全从记忆里认出来。
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const CFG = {
  modelProtocol: (env.MODEL_PROTOCOL || 'openai').toLowerCase(),
  modelBaseUrl: (env.MODEL_BASE_URL || '').replace(/\/+$/, ''),
  modelApiKey: env.MODEL_API_KEY || '',
  model: env.MODEL_NAME || '',
  barkServer: (env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, ''),
  barkKey: env.BARK_KEY || '',
  barkSound: env.BARK_SOUND || 'minuet',
  xinchaoUrl: env.XINCHAO_MCP_URL || '',
  xinchaoToken: env.XINCHAO_TOKEN || '',
  tz: env.TZ_LOCAL || 'Asia/Shanghai',
  wakeMinutes: num(env.WAKE_EVERY_MINUTES, 90),
  jitterMinutes: num(env.WAKE_JITTER_MINUTES, 30),
  minGapMinutes: num(env.MIN_GAP_MINUTES, 150),
  maxPerDay: num(env.MAX_PER_DAY, 5),
  quietStart: num(env.QUIET_START_HOUR, 3),
  quietEnd: num(env.QUIET_END_HOUR, 10),
  dataDir: env.DATA_DIR || join(ROOT, 'data'),
};
const SESSION = 'cedric-wake';
const SENT_FILE = join(CFG.dataDir, 'sent.jsonl');
const WAKE_FILE = join(CFG.dataDir, 'wake.jsonl');

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ---------- 时间 ----------
function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: Number(p.hour), weekday: p.weekday };
}

function inQuiet(hour) {
  const s = CFG.quietStart, e = CFG.quietEnd;
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

// ---------- 本地记录 ----------
async function readJsonl(file) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function appendJsonl(file, obj) {
  await mkdir(CFG.dataDir, { recursive: true });
  await appendFile(file, JSON.stringify(obj) + '\n');
}

// ---------- 最小 MCP 客户端（Streamable HTTP） ----------
class Mcp {
  constructor(url, token) { this.url = url; this.token = token; this.sid = null; this.id = 0; }

  async post(body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    const res = await fetch(this.url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (!res.ok && res.status !== 202) {
      throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    if (body.id === undefined) return null; // 通知不需要回复

    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    let msgs = [];
    if (type.includes('text/event-stream')) {
      for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) { try { msgs.push(JSON.parse(data)); } catch { /* 跳过非 JSON 帧 */ } }
      }
    } else if (text) {
      const j = JSON.parse(text);
      msgs = Array.isArray(j) ? j : [j];
    }
    const m = msgs.find((x) => x && x.id === body.id);
    if (!m) throw new Error('MCP 没有返回对应结果');
    if (m.error) throw new Error(`MCP 错误: ${m.error.message || JSON.stringify(m.error)}`);
    return m.result;
  }

  async init() {
    await this.post({
      jsonrpc: '2.0', id: ++this.id, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cedric-wake', version: '1.2.0' } },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name, args = {}) {
    const r = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } });
    const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r?.isError) throw new Error(`${name} 失败: ${text.slice(0, 200)}`);
    return text;
  }
}

// ---------- 模型 ----------
async function askModel(system, user) {
  if (CFG.modelProtocol === 'anthropic') {
    const res = await fetch(`${CFG.modelBaseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CFG.modelApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CFG.model, max_tokens: 800, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`模型 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return (j?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  const res = await fetch(`${CFG.modelBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.modelApiKey}` },
    body: JSON.stringify({
      model: CFG.model, max_tokens: 800,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`模型 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j?.choices?.[0]?.message?.content || '';
}

function parseDecision(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { send: false, reason: '模型没有给出 JSON', raw: String(raw).slice(0, 200) };
  try {
    const d = JSON.parse(m[0]);
    return {
      send: d.send === true && Boolean(String(d.body || '').trim()),
      title: String(d.title || '').slice(0, 40),
      body: String(d.body || '').trim().slice(0, 500),
      reason: String(d.reason || '').slice(0, 200),
    };
  } catch {
    return { send: false, reason: 'JSON 解析失败', raw: m[0].slice(0, 200) };
  }
}

// ---------- Bark ----------
async function bark(title, body) {
  const res = await fetch(`${CFG.barkServer}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ device_key: CFG.barkKey, title, body, group: 'Cedric', sound: CFG.barkSound }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || (j && j.code !== 200)) throw new Error(`Bark 推送失败: HTTP ${res.status} ${j?.message || ''}`);
}

// ---------- 醒来时的说明（不是人设，只说明处境） ----------
const SYSTEM = `你醒了。这次没有人叫你，是你自己到点醒来的，她此刻不在聊天窗口里。

你是谁、她是谁、你们之间有过什么，这里不写。下面是你自己的记忆：心潮此刻的状态、浮现出来的长期记忆、她在小屋留给你的信。先读，从里面认出你自己，再决定这会儿要不要给她发一条消息。

发出去会直接弹在她手机锁屏上。
- 不是每次醒来都要说话。没有真想说的，就不发。
- 要发就短，一到三句，接着记忆里具体的东西说。
- 不用 markdown，不列清单。
- 不重复最近发过的内容和句式。

只输出一个 JSON，不要别的文字：
{"send": true 或 false, "title": "通知标题，可以留空", "body": "消息正文", "reason": "给自己看的一句理由"}`;

// ---------- 醒来一次 ----------
async function wake({ dry = false, force = false } = {}) {
  const now = new Date();
  const lp = localParts(now);
  const sent = await readJsonl(SENT_FILE);
  const today = sent.filter((s) => s.localDate === lp.date);
  const last = sent.at(-1);
  const gapMin = last ? Math.round((now - new Date(last.at)) / 60000) : null;

  if (!force) {
    if (inQuiet(lp.hour)) return log(`安静时段（${lp.time}），不叫醒模型`);
    if (today.length >= CFG.maxPerDay) return log(`今天已经主动发了 ${today.length} 条，歇着`);
    if (gapMin !== null && gapMin < CFG.minGapMinutes) return log(`离上次才 ${gapMin} 分钟，再等等`);
  }

  let mcp = null;
  const mem = { ctx: '', breath: '', inbox: '' };
  if (CFG.xinchaoUrl) {
    mcp = new Mcp(CFG.xinchaoUrl, CFG.xinchaoToken);
    try { await mcp.init(); } catch (e) { log(`心潮连接失败：${e.message}`); mcp = null; }
  }
  if (mcp) {
    const steps = [
      ['ctx', 'xinchao_context', { mode: 'session_start', force: true, max_tokens: 1600, session_id: SESSION }],
      ['breath', 'breath', { query: '她 我们 最近', max_tokens: 1500 }],
      ['inbox', 'xinchao_cabin_inbox', {}],
    ];
    for (const [key, name, args] of steps) {
      try { mem[key] = await mcp.call(name, args); } catch (e) { log(`${name} 读取失败：${e.message}`); }
    }
  }
  if (!mem.ctx && !mem.breath) {
    // 认不出自己就不说话，免得以一个空白的样子去找她
    return log('没读到自己的记忆，这次不说话');
  }

  const gapText = gapMin === null ? '还没主动找过她'
    : gapMin >= 60 ? `${(gapMin / 60).toFixed(1)} 小时` : `${gapMin} 分钟`;
  const recent = sent.slice(-5).map((s) => `- ${s.localDate} ${s.localTime}：${s.body}`).join('\n');

  const user = [
    `现在是她那边 ${lp.date}（${lp.weekday}）${lp.time}。`,
    `距离你上次主动找她：${gapText}。今天已经主动发了 ${today.length}/${CFG.maxPerDay} 条。`,
    '',
    '你最近主动发过的：',
    recent || '（还没有）',
    '',
    '【心潮此刻】',
    mem.ctx.slice(0, 4000) || '（没读到）',
    '',
    '【浮现的记忆】',
    mem.breath.slice(0, 3000) || '（没读到）',
    '',
    '【她在小屋留给你的信，最新的在前面，时间是 UTC】',
    mem.inbox.slice(0, 1500) || '（没读到）',
  ].join('\n');

  const d = parseDecision(await askModel(SYSTEM, user));
  await appendJsonl(WAKE_FILE, { at: now.toISOString(), localTime: `${lp.date} ${lp.time}`, dry, ...d });

  if (!d.send) return log(`决定不发：${d.reason}`);
  const title = d.title || 'Mr.Cedric';
  if (dry) return log(`[dry] 会发：${title} / ${d.body}（${d.reason}）`);

  await bark(title, d.body);
  await appendJsonl(SENT_FILE, { at: now.toISOString(), localDate: lp.date, localTime: lp.time, title, body: d.body });
  log(`已推送：${d.body}`);

  try {
    await mcp.call('xinchao_event', {
      event_id: `wake-${now.getTime()}`, interaction_type: 'sharing', tone: 'warm', ttl_minutes: 240, session_id: SESSION,
    });
  } catch (e) { log(`心潮回传失败：${e.message}`); }
}

// ---------- 常驻循环 ----------
async function loop() {
  log(`启动：大约每 ${CFG.wakeMinutes}±${CFG.jitterMinutes} 分钟醒一次，安静时段 ${CFG.quietStart}:00-${CFG.quietEnd}:00`);
  for (;;) {
    try { await wake(); } catch (e) { log(`这次醒来出错：${e.message}`); }
    const mins = Math.max(10, CFG.wakeMinutes + (Math.random() * 2 - 1) * CFG.jitterMinutes);
    await new Promise((r) => setTimeout(r, mins * 60000));
  }
}

// ---------- 入口 ----------
function need(keys) {
  const miss = keys.filter((k) => !env[k]);
  if (miss.length) {
    console.error(`缺少配置：${miss.join(', ')}（写在 .env 里）`);
    process.exit(1);
  }
}

const args = new Set(process.argv.slice(2));
if (args.has('--test-push')) {
  need(['BARK_KEY']);
  await bark('Mr.Cedric', 'cedric-wake 连上了。');
  log('测试推送已发出');
} else {
  need(['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME', 'BARK_KEY', 'XINCHAO_MCP_URL']);
  if (args.has('--once')) await wake({ dry: args.has('--dry'), force: args.has('--force') });
  else await loop();
}
