import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { getR2DownloadUrl, isR2Configured } from './r2.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) || true, credentials: true }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/convert', rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.CONVERSION_REQUESTS_PER_HOUR || 20), standardHeaders: true, legacyHeaders: false }));

const port = Number(process.env.PORT || 8787);
const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.username ? { username: redisUrl.username } : {}), ...(redisUrl.password ? { password: redisUrl.password } : {}) };
const conversionQueue = new Queue('convertly-conversions', { connection });
const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const BATCH_TTL_SECONDS = Number(process.env.BATCH_TTL_SECONDS || 86400);
const JOB_META_TTL_SECONDS = Number(process.env.JOB_META_TTL_SECONDS || 86400);
const SHARE_LINK_TTL_SECONDS = Number(process.env.SHARE_LINK_TTL_SECONDS || 86400);
const isLocalDev = String(process.env.NODE_ENV || 'development').toLowerCase() === 'development';
const guestMode = String(process.env.ALLOW_GUEST_CONVERSION ?? (isLocalDev ? 'true' : 'false')).toLowerCase() === 'true';
const localStorageMode = String(process.env.LOCAL_TEST_STORAGE ?? (isLocalDev ? 'true' : 'false')).toLowerCase() === 'true';
const localOutputDir = path.resolve(process.env.TEMP_DIR || '/tmp/convertly');
const localOutputRoot = path.resolve(process.env.LOCAL_OUTPUT_DIR || path.join(localOutputDir, 'outputs'));
const localFileStorage = String(process.env.LOCAL_FILE_STORAGE ?? process.env.LOCAL_TEST_STORAGE ?? (isLocalDev ? 'true' : 'false')).toLowerCase() === 'true';
const storageAvailable = localFileStorage || isR2Configured();

function localStoragePathFromKey(key) {
  const cleanKey = String(key || '').replace(/^local:/, '');
  const resolved = path.resolve(localOutputRoot, cleanKey);
  if (resolved !== localOutputRoot && !resolved.startsWith(`${localOutputRoot}${path.sep}`)) throw new Error('Invalid local storage path.');
  return resolved;
}

function localStorageKey(userId, jobId, format) {
  return `local:${userId}/${jobId}.${format === 'mp3' ? 'mp3' : 'mp4'}`;
}

async function createLocalDownloadToken(id, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = Math.min(900, Math.max(60, Number(process.env.DOWNLOAD_LINK_TTL_SECONDS || 900)));
  await redis.set(`convertly:download:${token}`, JSON.stringify({ id, userId, local: true }), 'EX', ttl);
  return { token, ttl };
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) console.warn('Missing Supabase server environment variables. See backend/.env.example');
const supabaseAdmin = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } }) : null;
const supabasePublic = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } }) : null;

const LIMITS = {
  free: {
    dailyConversions: Number(process.env.FREE_DAILY_CONVERSIONS || 5),
    dailyHighQuality: 0,
    maxActive: Number(process.env.FREE_MAX_ACTIVE_JOBS || 1),
    maxDurationSeconds: Number(process.env.FREE_MAX_DURATION_SECONDS || 1800)
  },
  pro: {
    dailyConversions: Number(process.env.PRO_DAILY_CONVERSIONS || 30),
    dailyHighQuality: Number(process.env.PRO_DAILY_HIGH_QUALITY || 5),
    maxActive: Number(process.env.PRO_MAX_ACTIVE_JOBS || 2),
    maxDurationSeconds: Number(process.env.PRO_MAX_DURATION_SECONDS || 9000)
  },
  admin: {
    dailyConversions: Number(process.env.ADMIN_DAILY_CONVERSIONS || 10),
    dailyHighQuality: Number(process.env.ADMIN_DAILY_HIGH_QUALITY || 10),
    maxActive: Number(process.env.ADMIN_MAX_ACTIVE_JOBS || 4),
    maxDurationSeconds: Number(process.env.ADMIN_MAX_DURATION_SECONDS || 14400)
  }
};

function isYoutubeUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname);
  } catch { return false; }
}

function hasPermissionConfirmation(value) {
  return value === true;
}

function validatePermissionConfirmation(value) {
  if (!hasPermissionConfirmation(value)) return 'You must confirm that you own this content or have permission from the copyright owner to download and convert it.';
  return null;
}


const CREDIT_COSTS = {
  mp3: Number(process.env.CREDIT_COST_MP3 || 1),
  q1080: Number(process.env.CREDIT_COST_1080 || 1),
  q1440: Number(process.env.CREDIT_COST_1440 || 2),
  q2160: Number(process.env.CREDIT_COST_2160 || 3),
  targetSize: Number(process.env.CREDIT_COST_TARGET_SIZE || 1)
};

function creditCost({ quality, format, targetSizeMB }) {
  let cost = format === 'mp3' ? CREDIT_COSTS.mp3 : quality >= 2160 ? CREDIT_COSTS.q2160 : quality >= 1440 ? CREDIT_COSTS.q1440 : CREDIT_COSTS.q1080;
  if (format === 'mp4' && targetSizeMB) cost += CREDIT_COSTS.targetSize;
  return Math.max(1, Math.round(cost));
}

async function consumeCredits(userId, amount, referenceId) {
  if (!supabaseAdmin || !userId || amount <= 0) return { ok: true, balance: null };
  const { data, error } = await supabaseAdmin.rpc('consume_credits', { target_user_id: userId, credit_amount: amount, reference_id: referenceId });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.ok) {
    const err = new Error(result?.message || 'Not enough credits.');
    err.code = result?.code || 'INSUFFICIENT_CREDITS';
    err.balance = Number(result?.balance ?? 0);
    throw err;
  }
  return { ok: true, balance: Number(result.balance) };
}

async function refundCredits(userId, amount, referenceId) {
  if (!supabaseAdmin || !userId || amount <= 0) return;
  try { await supabaseAdmin.rpc('refund_credits', { target_user_id: userId, credit_amount: amount, reference_id: referenceId }); } catch (error) { console.warn('Credit refund failed:', error?.message || error); }
}

async function getCreditStatus(userId) {
  if (!supabaseAdmin || !userId) return { balance: 0, monthlyAllowance: 0, resetAt: null };
  const { data, error } = await supabaseAdmin.rpc('get_credit_status', { target_user_id: userId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { balance: Number(row?.balance ?? 0), monthlyAllowance: Number(row?.monthly_allowance ?? 0), resetAt: row?.reset_at || null };
}

function utcStartOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

async function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token && guestMode) { req.user = null; req.isGuest = true; return next(); }
  if (!token || !supabasePublic) return res.status(401).json({ error: 'Authentication required.' });
  const { data, error } = await supabasePublic.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session.' });
  req.user = data.user;
  req.isGuest = false;
  next();
}

async function getEntitlement(userId) {
  if (!supabaseAdmin) throw new Error('Server Supabase configuration is incomplete.');
  const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (profileError) throw profileError;
  const admin = profile?.role === 'admin';
  const { data: pro, error: proError } = await supabaseAdmin.rpc('has_pro_access', { target_user_id: userId });
  if (proError) throw proError;
  return { admin, pro: admin || pro === true, plan: admin ? 'admin' : pro === true ? 'pro' : 'free' };
}

async function trackServerEvent(eventName, userId = null, metadata = {}) {
  if (!supabaseAdmin || !eventName) return;
  try {
    await supabaseAdmin.from('analytics_events').insert({
      user_id: userId || null,
      event_name: eventName,
      metadata: { ...metadata, source: 'server' }
    });
  } catch (error) {
    console.warn('Analytics event could not be recorded:', eventName, error?.message || error);
  }
}

async function getUsage(userId) {
  const since = utcStartOfToday();
  const [all, high, active] = await Promise.all([
    supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since),
    supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since).gt('quality', 1080),
    supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('status', ['queued', 'processing'])
  ]);
  if (all.error || high.error || active.error) throw all.error || high.error || active.error;
  return { dailyConversions: all.count || 0, dailyHighQuality: high.count || 0, activeJobs: active.count || 0, resetAt: new Date(Date.parse(since) + 86400000).toISOString() };
}

app.get('/api', (_req, res) => {
  res.json({ ok: true, service: 'convertly-api', health: '/api/health', convert: '/api/convert' });
});

app.get('/api/health', async (_req, res) => {
  let redis = 'ok';
  try { await conversionQueue.waitUntilReady(); } catch { redis = 'error'; }
  res.json({ ok: redis === 'ok', service: 'convertly-api', redis, storage: localFileStorage ? 'local' : (isR2Configured() ? 'r2' : 'not-configured'), timestamp: new Date().toISOString() });
});

app.get('/api/limits', requireUser, async (req, res) => {
  try {
    const entitlement = await getEntitlement(req.user.id);
    const limits = LIMITS[entitlement.plan];
    const usage = await getUsage(req.user.id);
    res.json({ plan: entitlement.plan, limits, usage, credits: entitlement.pro ? await getCreditStatus(req.user.id) : { balance: 0, monthlyAllowance: 0, resetAt: null } });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load usage limits.' }); }
});

app.get('/api/billing/status', requireUser, async (req, res) => {
  try {
    const entitlement = await getEntitlement(req.user.id);
    const credits = entitlement.pro ? await getCreditStatus(req.user.id) : { balance: 0, monthlyAllowance: 0, resetAt: null };
    res.json({ ok: true, plan: entitlement.plan, pro: entitlement.pro, credits, costs: CREDIT_COSTS, payment: { provider: process.env.PAYMENT_PROVIDER || 'not-configured', checkout: 'not-configured' } });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load billing status.' }); }
});



function batchMaxItems(plan) {
  return plan === 'admin' ? 20 : plan === 'pro' ? 20 : 5;
}

function validateConversionItem(item) {
  const url = String(item?.url || '').trim();
  const quality = Number(item?.quality || 1080);
  const format = String(item?.format || 'mp4').toLowerCase();
  const targetSizeMB = item?.targetSizeMB == null || item?.targetSizeMB === '' ? null : Number(item.targetSizeMB);
  const permissionError = validatePermissionConfirmation(item?.permissionConfirmed);
  if (permissionError) return { error: permissionError };
  if (!url || !isYoutubeUrl(url)) return { error: 'Only supported YouTube URLs are accepted.' };
  if (url.length > 2048) return { error: 'URL is too long.' };
  if (!['mp4', 'mp3'].includes(format)) return { error: 'Unsupported output format.' };
  if (![144, 360, 480, 720, 1080, 1440, 2160].includes(quality)) return { error: 'Unsupported quality.' };
  if (format === 'mp3' && quality > 1080) return { error: 'MP3 output does not use video quality. Please select 1080p or lower.' };
  if (targetSizeMB !== null && (!Number.isFinite(targetSizeMB) || targetSizeMB < 1 || targetSizeMB > 500)) return { error: 'Target file size must be between 1 MB and 500 MB.' };
  if (targetSizeMB !== null && format !== 'mp4') return { error: 'Target file size is currently available for MP4 only.' };
  return { url, quality, format, targetSizeMB, permissionConfirmed: true };
}

async function setBatch(batchId, value) {
  await redis.set(`convertly:batch:${batchId}`, JSON.stringify(value), 'EX', BATCH_TTL_SECONDS);
}

async function getProgressMeta(jobId) {
  try {
    const raw = await redis.get(`convertly:progress:${jobId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}


async function setJobMeta(jobId, value) {
  await redis.set(`convertly:job:${jobId}`, JSON.stringify(value), 'EX', JOB_META_TTL_SECONDS);
}

async function getJobMeta(jobId) {
  try {
    const raw = await redis.get(`convertly:job:${jobId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function markCancelled(jobId, reason = 'Cancelled by user.') {
  await redis.set(`convertly:cancel:${jobId}`, '1', 'EX', JOB_META_TTL_SECONDS);
  const meta = await getJobMeta(jobId);
  if (meta) await setJobMeta(jobId, { ...meta, status: 'cancelled', error_message: reason, cancelledAt: new Date().toISOString() });
}

async function enqueueConversionJob(data, jobId) {
  await setJobMeta(jobId, { ...data, jobId, status: 'queued', progress: 0, error_message: null, createdAt: new Date().toISOString() });
  await conversionQueue.add(data.format === 'mp3' ? 'youtube-to-mp3' : 'youtube-to-mp4', data, {
    jobId, removeOnComplete: 1000, removeOnFail: 1000
  });
}

app.post('/api/batch-convert', requireUser, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Add at least one conversion item.' });
  if (items.length > 20) return res.status(400).json({ error: 'A batch can contain at most 20 items.' });

  try {
    const guest = Boolean(req.isGuest);
    if (!guest && !storageAvailable) return res.status(503).json({ error: 'Video storage is not configured yet. Enable local file storage or connect object storage.' });
    if (guest && !localStorageMode) return res.status(503).json({ error: 'Guest test mode requires LOCAL_TEST_STORAGE=true on the backend.' });
    const entitlement = guest ? { admin: false, pro: false, plan: 'free' } : await getEntitlement(req.user.id);
    const limits = LIMITS[entitlement.plan];
    const usage = guest ? { dailyConversions: 0, dailyHighQuality: 0, activeJobs: 0, resetAt: null } : await getUsage(req.user.id);
    const maxItems = batchMaxItems(entitlement.plan);
    if (items.length > maxItems) return res.status(403).json({ error: `Batch size is limited to ${maxItems} items on the ${entitlement.plan} plan.` });
    if (items.length > limits.dailyConversions - usage.dailyConversions) return res.status(429).json({ error: `This batch needs ${items.length} conversion slots, but only ${Math.max(0, limits.dailyConversions - usage.dailyConversions)} remain today.` });

    const parsed = items.map(validateConversionItem);
    const invalid = parsed.findIndex(item => item.error);
    if (invalid >= 0) return res.status(400).json({ error: `Item ${invalid + 1}: ${parsed[invalid].error}` });
    if (parsed.some(item => item.quality > 1080) && !entitlement.pro) return res.status(403).json({ error: '1440p and 4K require Pro access.' });
    if (parsed.filter(item => item.quality > 1080).length > limits.dailyHighQuality - usage.dailyHighQuality) return res.status(429).json({ error: 'This batch exceeds the remaining high-quality conversion allowance.' });

    const batchId = crypto.randomUUID();
    const userId = guest ? `guest:${batchId}` : req.user.id;
    const jobs = [];
    await setBatch(batchId, { batchId, userId, status: 'queued', total: parsed.length, completed: 0, failed: 0, items: [] });

    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index];
      const jobId = crypto.randomUUID();
      const cost = entitlement.pro && !entitlement.admin ? creditCost(item) : 0;
      if (cost > 0) await consumeCredits(req.user.id, cost, jobId);
      if (!guest) {
        const { error: insertError } = await supabaseAdmin.from('conversions').insert({ id: jobId, user_id: userId, source: 'youtube', source_url: item.url, quality: item.quality, format: item.format, status: 'queued', progress: 0, job_id: jobId });
        if (insertError) { if (cost > 0) await refundCredits(req.user.id, cost, jobId); throw insertError; }
      }
      try {
        await enqueueConversionJob({
          jobId, userId, url: item.url, quality: item.quality, format: item.format, targetSizeMB: item.targetSizeMB, permissionConfirmed: true,
          maxDurationSeconds: limits.maxDurationSeconds, guest, localStorageMode, batchId, batchIndex: index, creditCost: cost
        }, jobId);
      } catch (queueError) {
        if (cost > 0) await refundCredits(req.user.id, cost, jobId);
        if (!guest) await supabaseAdmin.from('conversions').update({ status: 'failed', error_message: 'Queue unavailable.' }).eq('id', jobId);
        throw queueError;
      }
      jobs.push({ jobId, index, url: item.url, quality: item.quality, format: item.format, status: 'queued', progress: 0, error: null });
    }
    await setBatch(batchId, { batchId, userId, status: 'queued', total: jobs.length, completed: 0, failed: 0, items: jobs });
    res.status(202).json({ ok: true, batchId, status: 'queued', total: jobs.length, jobs, plan: entitlement.plan });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create batch conversion.' });
  }
});

app.get('/api/batch/:id', requireUser, async (req, res) => {
  try {
    const raw = await redis.get(`convertly:batch:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: 'Batch not found or expired.' });
    const batch = JSON.parse(raw);
    if (!req.isGuest && batch.userId && batch.userId !== req.user.id) return res.status(403).json({ error: 'You do not have access to this batch.' });
    const etaSeconds = batch.status === 'completed' || batch.status === 'completed_with_errors' ? 0 : Math.max(0, ...(batch.items || []).map(item => Number(item.etaSeconds || 0)));
    const activeItems = (batch.items || []).filter(item => item.status === 'processing');
    const overallProgress = batch.total ? Math.round((batch.items || []).reduce((sum, item) => sum + Number(item.progress || 0), 0) / batch.total) : 0;
    res.json({ ...batch, progress: overallProgress, etaSeconds, activeItems: activeItems.length });
  } catch { res.status(500).json({ error: 'Could not load batch status.' }); }
});

app.post('/api/convert', requireUser, async (req, res) => {
  const source = String(req.body?.source || 'youtube');
  const url = String(req.body?.url || '').trim();
  const quality = Number(req.body?.quality || 1080);
  const format = String(req.body?.format || 'mp4').toLowerCase();
  const targetSizeMB = req.body?.targetSizeMB == null || req.body?.targetSizeMB === '' ? null : Number(req.body.targetSizeMB);
  const permissionError = validatePermissionConfirmation(req.body?.permissionConfirmed);

  if (permissionError) return res.status(400).json({ error: permissionError, code: 'PERMISSION_CONFIRMATION_REQUIRED' });
  if (source !== 'youtube' || !isYoutubeUrl(url)) return res.status(400).json({ error: 'Only supported YouTube URLs are accepted by the main converter.' });
  if (url.length > 2048) return res.status(400).json({ error: 'URL is too long.' });
  if (!['mp4', 'mp3'].includes(format)) return res.status(400).json({ error: 'Unsupported output format.' });
  if (![144, 360, 480, 720, 1080, 1440, 2160].includes(quality)) return res.status(400).json({ error: 'Unsupported quality.' });
  if (format === 'mp3' && quality > 1080) return res.status(400).json({ error: 'MP3 output does not use video quality. Please select 1080p or lower.' });
  if (targetSizeMB !== null && (!Number.isFinite(targetSizeMB) || targetSizeMB < 1 || targetSizeMB > 500)) return res.status(400).json({ error: 'Target file size must be between 1 MB and 500 MB.' });
  if (targetSizeMB !== null && format !== 'mp4') return res.status(400).json({ error: 'Target file size is currently available for MP4 only.' });

  try {
    const guest = Boolean(req.isGuest);
    if (!guest && !storageAvailable) return res.status(503).json({ error: 'Video storage is not configured yet. Enable local file storage or connect object storage.' });
    if (guest && !localStorageMode) return res.status(503).json({ error: 'Guest test mode requires LOCAL_TEST_STORAGE=true on the backend.' });
    const entitlement = guest ? { admin: false, pro: false, plan: 'free' } : await getEntitlement(req.user.id);
    const limits = LIMITS[entitlement.plan];
    const usage = guest ? { dailyConversions: 0, dailyHighQuality: 0, activeJobs: 0, resetAt: null } : await getUsage(req.user.id);

    if (usage.dailyConversions >= limits.dailyConversions) {
      return res.status(429).json({ error: `Daily conversion limit reached (${limits.dailyConversions}). Try again after the daily reset.`, code: 'DAILY_LIMIT_REACHED', usage, limits });
    }
    if (usage.activeJobs >= limits.maxActive) {
      return res.status(429).json({ error: `You already have ${limits.maxActive} active conversion job${limits.maxActive === 1 ? '' : 's'}. Wait for one to finish.`, code: 'ACTIVE_JOB_LIMIT_REACHED', usage, limits });
    }
    if (quality > 1080 && usage.dailyHighQuality >= limits.dailyHighQuality) {
      return res.status(429).json({ error: `High-quality daily limit reached (${limits.dailyHighQuality}).`, code: 'HIGH_QUALITY_LIMIT_REACHED', usage, limits });
    }
    if (quality > 1080 && !entitlement.pro) return res.status(403).json({ error: '1440p and 4K require Pro access.' });

    const jobId = crypto.randomUUID();
    const userId = guest ? `guest:${jobId}` : req.user.id;
    const cost = entitlement.pro && !entitlement.admin ? creditCost({ quality, format, targetSizeMB }) : 0;
    if (cost > 0) await consumeCredits(req.user.id, cost, jobId);
    if (!guest) {
      const { error: insertError } = await supabaseAdmin.from('conversions').insert({ id: jobId, user_id: userId, source, source_url: url, quality, format, status: 'queued', progress: 0, job_id: jobId });
      if (insertError) { if (cost > 0) await refundCredits(req.user.id, cost, jobId); return res.status(500).json({ error: 'Could not create conversion job.' });}
    }

    try {
      await enqueueConversionJob({ jobId, userId, url, quality, format, targetSizeMB, permissionConfirmed: true, maxDurationSeconds: limits.maxDurationSeconds, guest, localStorageMode, creditCost: cost }, jobId);
    } catch (queueError) {
      if (cost > 0) await refundCredits(req.user.id, cost, jobId);
      if (!guest) await supabaseAdmin.from('conversions').update({ status: 'failed', error_message: 'Queue unavailable.' }).eq('id', jobId);
      throw queueError;
    }
    await trackServerEvent('conversion_started', guest ? null : req.user.id, { format, quality, targetSizeMB: targetSizeMB || null, plan: entitlement.plan, guest, permissionConfirmed: true });
    res.status(202).json({ ok: true, jobId, status: 'queued', targetSizeMB, plan: entitlement.plan, guest, usage: { ...usage, dailyConversions: usage.dailyConversions + 1 }, limits, message: 'Conversion queued. Only process content you own or are authorized to use.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create conversion job.' });
  }
});

app.get('/api/conversion/:id', requireUser, async (req, res) => {
  const id = req.params.id;
  const meta = await getJobMeta(id);
  const cancelled = Boolean(await redis.get(`convertly:cancel:${id}`));
  if (req.isGuest) {
    const job = await conversionQueue.getJob(id);
    if (!job && !meta) return res.status(404).json({ error: 'Conversion not found.' });
    if (!job) return res.json({ id, ...meta, status: cancelled ? 'cancelled' : (meta?.status || 'queued') });
    const state = await job.getState();
    const bullProgress = typeof job.progress === 'number' ? job.progress : 0;
    const metaProgress = Number(meta?.progress || 0);
    const progress = Math.max(bullProgress, metaProgress);
    const rawStatus = state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'active' ? 'processing' : state === 'waiting' ? 'queued' : state;
    const status = cancelled ? 'cancelled' : rawStatus;
    const progressMeta = await getProgressMeta(id);
    return res.json({ id: job.id, status, progress, etaSeconds: status === 'completed' || status === 'cancelled' ? 0 : (progressMeta?.etaSeconds ?? null), elapsedSeconds: progressMeta?.elapsedSeconds ?? null, updatedAt: progressMeta?.updatedAt ?? null, quality: job.data.quality, format: job.data.format, error_message: cancelled ? (meta?.error_message || 'Cancelled by user.') : (job.failedReason || null), output_path: job.returnvalue || null, url: job.data.url });
  }
  const { data, error } = await supabaseAdmin.from('conversions').select('id,status,progress,quality,format,error_message,download_expires_at,output_path,created_at,completed_at').eq('id', id).eq('user_id', req.user.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load conversion.' });
  if (!data) return res.status(404).json({ error: 'Conversion not found.' });
  if (cancelled && ['queued','processing','failed'].includes(data.status)) data.status = 'cancelled';
  res.json(data);
});

app.post('/api/conversion/:id/cancel', requireUser, async (req, res) => {
  const id = req.params.id;
  try {
    const job = await conversionQueue.getJob(id);
    const meta = await getJobMeta(id);
    if (!job && !meta) return res.status(404).json({ error: 'Conversion not found.' });
    if (req.isGuest && meta?.guest === false) return res.status(403).json({ error: 'You do not have access to this conversion.' });
    if (!req.isGuest && meta?.userId && meta.userId !== req.user.id) return res.status(403).json({ error: 'You do not have access to this conversion.' });
    if (job) {
      const state = await job.getState();
      if (state === 'completed') return res.status(409).json({ error: 'Conversion is already complete.' });
      if (state === 'failed') return res.json({ ok: true, id, status: 'cancelled' });
      await markCancelled(id);
      if (['waiting','delayed','paused'].includes(state)) {
        await job.remove().catch(() => {});
        if (!req.isGuest && supabaseAdmin) await supabaseAdmin.from('conversions').update({ status: 'cancelled', error_message: 'Cancelled by user.' }).eq('id', id).eq('user_id', req.user.id);
        return res.json({ ok: true, id, status: 'cancelled' });
      }
      if (!req.isGuest && supabaseAdmin) await supabaseAdmin.from('conversions').update({ status: 'cancelled', error_message: 'Cancellation requested.' }).eq('id', id).eq('user_id', req.user.id);
      return res.json({ ok: true, id, status: 'cancelling' });
    }
    await markCancelled(id);
    if (!req.isGuest && supabaseAdmin) await supabaseAdmin.from('conversions').update({ status: 'cancelled', error_message: 'Cancelled by user.' }).eq('id', id).eq('user_id', req.user.id);
    res.json({ ok: true, id, status: 'cancelled' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not cancel conversion.' });
  }
});

app.post('/api/conversion/:id/retry', requireUser, async (req, res) => {
  const oldId = req.params.id;
  const permissionError = validatePermissionConfirmation(req.body?.permissionConfirmed);
  if (permissionError) return res.status(400).json({ error: permissionError, code: 'PERMISSION_CONFIRMATION_REQUIRED' });
  try {
    const oldJob = await conversionQueue.getJob(oldId);
    const meta = await getJobMeta(oldId);
    let data = oldJob?.data || meta;
    if (!data) return res.status(404).json({ error: 'Conversion not found.' });
    if (!req.isGuest && data.userId && data.userId !== req.user.id) return res.status(403).json({ error: 'You do not have access to this conversion.' });
    const oldState = oldJob ? await oldJob.getState() : meta?.status;
    if (!['failed','cancelled'].includes(oldState) && !['failed','cancelled'].includes(meta?.status)) return res.status(409).json({ error: 'Only failed or cancelled conversions can be retried.' });
    const newId = crypto.randomUUID();
    const userId = req.isGuest ? `guest:${newId}` : req.user.id;
    const guest = Boolean(req.isGuest);
    const entitlement = guest ? { admin: false, pro: false, plan: 'free' } : await getEntitlement(req.user.id);
    const limits = LIMITS[entitlement.plan];
    if (Number(data.quality) > 1080 && !entitlement.pro) return res.status(403).json({ error: '1440p and 4K require Pro access.' });
    if (!guest) {
      const { error } = await supabaseAdmin.from('conversions').insert({ id: newId, user_id: userId, source: 'youtube', source_url: data.url, quality: Number(data.quality), format: data.format, status: 'queued', progress: 0, job_id: newId });
      if (error) return res.status(500).json({ error: 'Could not create retry conversion.' });
    }
    const retryCost = entitlement.pro && !entitlement.admin ? creditCost({ quality: Number(data.quality), format: data.format, targetSizeMB: data.targetSizeMB ?? null }) : 0;
    if (retryCost > 0) await consumeCredits(req.user.id, retryCost, newId);
    const newData = { jobId: newId, userId, url: data.url, quality: Number(data.quality), format: data.format, targetSizeMB: data.targetSizeMB ?? null, permissionConfirmed: true, maxDurationSeconds: limits.maxDurationSeconds, guest, localStorageMode, batchId: null, batchIndex: null, creditCost: retryCost };
    await enqueueConversionJob(newData, newId);
    res.status(202).json({ ok: true, oldJobId: oldId, jobId: newId, status: 'queued' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not retry conversion.' });
  }
});

app.post('/api/conversion/:id/share', requireUser, async (req, res) => {
  const id = req.params.id;
  try {
    const job = await conversionQueue.getJob(id);
    const meta = await getJobMeta(id);
    if (req.isGuest) {
      if (!job && !meta) return res.status(404).json({ error: 'Conversion not found.' });
      if (meta?.guest === false) return res.status(403).json({ error: 'You do not have access to this conversion.' });
      const state = job ? await job.getState() : meta?.status;
      if (state !== 'completed' && meta?.status !== 'completed') return res.status(409).json({ error: 'Only completed conversions can be shared.' });
      if (!job?.returnvalue && !meta?.output_path) return res.status(409).json({ error: 'Conversion output is not available yet.' });
    } else {
      const { data, error } = await supabaseAdmin.from('conversions').select('id,status,output_path,download_expires_at').eq('id', id).eq('user_id', req.user.id).maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'Conversion not found.' });
      if (data.status !== 'completed' || !data.output_path) return res.status(409).json({ error: 'Only completed conversions can be shared.' });
      if (data.download_expires_at && new Date(data.download_expires_at) <= new Date()) return res.status(410).json({ error: 'Download expired. Please run the conversion again.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`convertly:share:${token}`, JSON.stringify({ id, userId: req.isGuest ? null : req.user.id, guest: Boolean(req.isGuest), createdAt: new Date().toISOString() }), 'EX', SHARE_LINK_TTL_SECONDS);
    const publicBase = String(process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const url = `${publicBase}/api/share/${token}`;
    res.status(201).json({ ok: true, url, expiresIn: SHARE_LINK_TTL_SECONDS });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create share link.' });
  }
});

app.get('/api/share/:token', async (req, res) => {
  try {
    const localDownloadRaw = await redis.get(`convertly:download:${req.params.token}`);
    if (localDownloadRaw) {
      const download = JSON.parse(localDownloadRaw);
      if (!supabaseAdmin || !download?.id || !download?.userId) return res.status(410).json({ error: 'This download link is no longer available.' });
      const { data, error } = await supabaseAdmin.from('conversions').select('id,status,output_path,download_expires_at,format').eq('id', download.id).eq('user_id', download.userId).maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'Download not found.' });
      if (data.status !== 'completed' || !data.output_path || !data.output_path.startsWith('local:')) return res.status(410).json({ error: 'This download is no longer available.' });
      if (data.download_expires_at && new Date(data.download_expires_at) <= new Date()) return res.status(410).json({ error: 'This download has expired.' });
      const file = localStoragePathFromKey(data.output_path);
      try { await stat(file); } catch { return res.status(410).json({ error: 'This download file has expired. Please run the conversion again.' }); }
      return res.download(file, path.basename(file));
    }
    const raw = await redis.get(`convertly:share:${req.params.token}`);
    if (!raw) return res.status(410).json({ error: 'This share link has expired or is invalid.' });
    const share = JSON.parse(raw);
    if (share.guest) {
      const job = await conversionQueue.getJob(share.id);
      if (!job || (await job.getState()) !== 'completed' || !job.returnvalue) return res.status(410).json({ error: 'This shared conversion is no longer available.' });
      try { await stat(job.returnvalue); } catch { return res.status(410).json({ error: 'This shared conversion file is no longer available.' }); }
      return res.download(job.returnvalue, path.basename(job.returnvalue));
    }
    const { data, error } = await supabaseAdmin.from('conversions').select('id,status,output_path,download_expires_at').eq('id', share.id).eq('user_id', share.userId).maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'Shared conversion not found.' });
    if (data.status !== 'completed' || !data.output_path) return res.status(410).json({ error: 'This shared conversion is no longer available.' });
    if (data.download_expires_at && new Date(data.download_expires_at) <= new Date()) return res.status(410).json({ error: 'This shared conversion has expired.' });
    if (data.output_path.startsWith('local:')) {
      const file = localStoragePathFromKey(data.output_path);
      try { await stat(file); } catch { return res.status(410).json({ error: 'This shared conversion file is no longer available.' }); }
      return res.download(file, path.basename(file));
    }
    const url = await getR2DownloadUrl(data.output_path, Math.min(900, SHARE_LINK_TTL_SECONDS));
    return res.redirect(url);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not open shared download.' });
  }
});

app.get('/api/download/:id', requireUser, async (req, res) => {
  if (req.isGuest) {
    const job = await conversionQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Conversion not found.' });
    const state = await job.getState();
    const file = job.returnvalue;
    if (await redis.get(`convertly:cancel:${req.params.id}`)) return res.status(409).json({ error: 'Conversion was cancelled.' });
    if (state !== 'completed' || !file) return res.status(409).json({ error: 'Conversion is not ready.' });
    try {
      await stat(file);
    } catch {
      return res.status(410).json({ error: 'Local test output has expired. Please run the conversion again.' });
    }
    return res.download(file, path.basename(file));
  }
  const { data, error } = await supabaseAdmin.from('conversions').select('id,status,output_path,download_expires_at,format').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Conversion not found.' });
  if (data.status !== 'completed' || !data.output_path) return res.status(409).json({ error: 'Conversion is not ready.' });
  if (data.download_expires_at && new Date(data.download_expires_at) <= new Date()) return res.status(410).json({ error: 'Download expired.' });
  if (data.output_path.startsWith('local:')) {
    try {
      const file = localStoragePathFromKey(data.output_path);
      await stat(file);
      const { token, ttl } = await createLocalDownloadToken(data.id, req.user.id);
      const publicBase = String(process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      return res.json({ url: `${publicBase}/api/share/${token}`, expiresIn: ttl });
    } catch { return res.status(410).json({ error: 'Download file is no longer available. Please run the conversion again.' }); }
  }
  try {
    const url = await getR2DownloadUrl(data.output_path, 900);
    res.json({ url, expiresIn: 900 });
  } catch { res.status(500).json({ error: 'Could not create download link.' }); }
});


app.post('/api/admin/credits/grant', requireUser, async (req, res) => {
  try {
    const { data: admin } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).maybeSingle();
    if (admin?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    const userId = String(req.body?.userId || '').trim();
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || 'Admin credit grant').slice(0, 200);
    if (!userId || !Number.isInteger(amount) || amount <= 0 || amount > 100000) return res.status(400).json({ error: 'Provide a valid userId and credit amount.' });
    const { data, error } = await supabaseAdmin.rpc('grant_credits', { target_user_id: userId, credit_amount: amount, reason });
    if (error) throw error;
    res.json({ ok: true, userId, amount, status: data });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not grant credits.' }); }
});

app.get('/api/admin/analytics', requireUser, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Analytics storage is not configured.' });
    const { data: admin } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).maybeSingle();
    if (admin?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    const requestedDays = Number(req.query.days || 30);
    const days = Math.min(90, Math.max(7, Number.isFinite(requestedDays) ? Math.floor(requestedDays) : 30));
    const sinceDate = new Date(Date.now() - days * 86400000);
    const since = sinceDate.toISOString();
    const { data: events, error } = await supabaseAdmin
      .from('analytics_events')
      .select('event_name,user_id,metadata,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10000);
    if (error) throw error;

    const rows = events || [];
    const eventCounts = {};
    const uniqueUsers = new Set();
    const daily = {};
    const formats = {};
    const qualities = {};
    const plans = {};
    let conversionStarted = 0;
    let conversionCompleted = 0;
    let conversionFailed = 0;
    let conversionCancelled = 0;

    for (const row of rows) {
      const name = String(row.event_name || 'unknown');
      eventCounts[name] = (eventCounts[name] || 0) + 1;
      if (row.user_id) uniqueUsers.add(row.user_id);
      const day = String(row.created_at || '').slice(0, 10);
      if (day) daily[day] = (daily[day] || 0) + 1;
      const format = row.metadata?.format;
      if (format) formats[String(format)] = (formats[String(format)] || 0) + 1;
      const quality = Number(row.metadata?.quality || 0);
      if (quality) qualities[String(quality)] = (qualities[String(quality)] || 0) + 1;
      const plan = row.metadata?.plan;
      if (plan) plans[String(plan)] = (plans[String(plan)] || 0) + 1;
      if (name === 'conversion_started') conversionStarted += 1;
      if (name === 'conversion_completed') conversionCompleted += 1;
      if (name === 'conversion_failed') conversionFailed += 1;
      if (name === 'conversion_cancelled') conversionCancelled += 1;
    }
    const successRate = conversionStarted ? Math.round((conversionCompleted / conversionStarted) * 1000) / 10 : 0;
    const dailySeries = Array.from({ length: days }, (_, index) => {
      const d = new Date(Date.UTC(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth(), sinceDate.getUTCDate() + index + 1));
      const key = d.toISOString().slice(0, 10);
      return { date: key, events: daily[key] || 0 };
    });
    res.json({
      days,
      since,
      totals: { events: rows.length, uniqueUsers: uniqueUsers.size, conversionStarted, conversionCompleted, conversionFailed, conversionCancelled, successRate },
      eventCounts,
      formats,
      qualities,
      plans,
      daily: dailySeries,
      recentEvents: rows.slice(0, 100)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load analytics.' });
  }
});

app.get('/api/admin/overview', requireUser, async (req, res) => {
  try {
    const { data: admin } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).maybeSingle();
    if (admin?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    const [users, pro, conversions, failed, events, today] = await Promise.all([
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('subscriptions').select('id', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
      supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      supabaseAdmin.from('analytics_events').select('event_name,metadata,created_at').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('conversions').select('id', { count: 'exact', head: true }).gte('created_at', utcStartOfToday())
    ]);
    const qualities = {};
    for (const e of events.data || []) { const q = Number(e.metadata?.quality || 0); if (q) qualities[q] = (qualities[q] || 0) + 1; }
    const topQuality = Object.entries(qualities).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    res.json({ users: users.count || 0, activePro: pro.count || 0, conversions: conversions.count || 0, failed: failed.count || 0, conversionsToday: today.count || 0, topQuality: topQuality ? Number(topQuality) : null, limits: LIMITS, storage: localFileStorage ? 'local' : (isR2Configured() ? 'R2' : 'not-configured'), recentEvents: events.data || [] });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load admin overview.' }); }
});

app.listen(port, () => console.log(`Convertly API listening on :${port}`));
