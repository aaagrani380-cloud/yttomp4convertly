import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { putR2Object, isR2Configured } from './r2.js';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.username ? { username: redisUrl.username } : {}), ...(redisUrl.password ? { password: redisUrl.password } : {}) };
const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const PROGRESS_TTL_SECONDS = Number(process.env.PROGRESS_TTL_SECONDS || 86400);

async function updateProgressMeta(jobId, progress, startedAt) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const etaSeconds = progress > 0 && progress < 100
    ? Math.max(0, Math.ceil((elapsedSeconds / progress) * (100 - progress)))
    : 0;
  const payload = { progress, startedAt, updatedAt: new Date(now).toISOString(), elapsedSeconds, etaSeconds };
  await redis.set(`convertly:progress:${jobId}`, JSON.stringify(payload), 'EX', PROGRESS_TTL_SECONDS);
  return payload;
}

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
const tempRoot = process.env.TEMP_DIR || path.join(os.tmpdir(), 'convertly');
const guestOutputRoot = process.env.GUEST_OUTPUT_DIR || path.join(tempRoot, 'guest-output');
const localOutputRoot = path.resolve(process.env.LOCAL_OUTPUT_DIR || path.join(tempRoot, 'outputs'));
const isLocalDev = String(process.env.NODE_ENV || 'development').toLowerCase() === 'development';
const localStorageMode = String(process.env.LOCAL_FILE_STORAGE ?? process.env.LOCAL_TEST_STORAGE ?? (isLocalDev ? 'true' : 'false')).toLowerCase() === 'true';

function localOutputPath(userId, jobId, format) {
  return path.join(localOutputRoot, String(userId), `${jobId}.${format === 'mp3' ? 'mp3' : 'mp4'}`);
}

function localOutputKey(userId, jobId, format) {
  return `local:${userId}/${jobId}.${format === 'mp3' ? 'mp3' : 'mp4'}`;
}

async function trackServerEvent(eventName, userId = null, metadata = {}) {
  if (!supabase || !eventName) return;
  try {
    await supabase.from('analytics_events').insert({
      user_id: userId || null,
      event_name: eventName,
      metadata: { ...metadata, source: 'worker' }
    });
  } catch (error) {
    console.warn('Worker analytics event failed:', eventName, error?.message || error);
  }
}


async function refundCredits(userId, amount, referenceId) {
  if (!supabase || !userId || String(userId).startsWith('guest:') || amount <= 0) return;
  try { await supabase.rpc('refund_credits', { target_user_id: userId, credit_amount: amount, reference_id: referenceId }); } catch (error) { console.warn('Worker credit refund failed:', error?.message || error); }
}

function run(cmd, args, onProgress, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let cancelled = false;
    const cancelPoll = jobId ? setInterval(async () => {
      try {
        if (await redis.get(`convertly:cancel:${jobId}`)) {
          cancelled = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2500);
        }
      } catch {}
    }, 500) : null;
    const finish = () => { if (cancelPoll) clearInterval(cancelPoll); };
    const handleProgressText = chunk => {
      const text = chunk.toString();
      stderr += text;
      const matches = text.match(/(?:^|\s|\])([0-9]{1,3}(?:\.[0-9]+)?)%/gm);
      if (matches?.length) {
        const last = matches[matches.length - 1].match(/([0-9]{1,3}(?:\.[0-9]+)?)%/);
        if (last) onProgress?.(Math.min(100, Math.max(0, Number.parseFloat(last[1]))));
      }
    };
    child.stdout.on('data', handleProgressText);
    child.stderr.on('data', handleProgressText);
    child.on('error', err => { finish(); reject(err); });
    child.on('close', code => {
      finish();
      if (cancelled) return reject(Object.assign(new Error('Conversion cancelled by user.'), { code: 'CONVERSION_CANCELLED' }));
      code === 0 ? resolve() : reject(new Error(stderr.slice(-4000) || `${cmd} exited with ${code}`));
    });
  });
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.slice(-4000) || `${cmd} exited with ${code}`)));
  });
}

async function compressToTarget(input, output, targetSizeMB, onProgress, jobId) {
  const targetBytes = Number(targetSizeMB) * 1024 * 1024;
  const inputStat = await stat(input);
  if (inputStat.size <= targetBytes) return false;
  const duration = Number(await runCapture(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input]));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine video duration for target-size compression.');
  const totalBits = targetBytes * 8 * 0.90;
  const audioKbps = 96;
  const videoKbps = Math.max(160, Math.floor(totalBits / duration / 1000 - audioKbps));
  await run(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', process.env.TARGET_SIZE_PRESET || 'veryfast',
    '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${Math.max(videoKbps * 2, 320)}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', '-progress', 'pipe:2', output
  ], p => onProgress?.(Math.min(98, 90 + Math.round((p / 100) * 8))), jobId);
  const outputStat = await stat(output);
  if (outputStat.size > targetBytes) {
    const tighter = Math.max(128, Math.floor(videoKbps * targetBytes / outputStat.size * 0.92));
    await run(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', process.env.TARGET_SIZE_PRESET || 'veryfast',
      '-b:v', `${tighter}k`, '-maxrate', `${tighter}k`, '-bufsize', `${Math.max(tighter * 2, 256)}k`,
      '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', output
    ], p => onProgress?.(Math.min(99, 96 + Math.round((p / 100) * 3))), jobId);
  }
  return true;
}

function qualityFormat(q) {
  if (q >= 2160) return 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
  return `bestvideo[height<=${q}]+bestaudio/best[height<=${q}]`;
}

if (!localStorageMode && !isR2Configured()) console.warn('No output storage is configured. Enable LOCAL_FILE_STORAGE or configure R2.');
if (localStorageMode) console.log(`Local file storage enabled. Output TTL: ${Number(process.env.DOWNLOAD_TTL_MINUTES || 30)} minutes.`);


async function updateBatch(batchId, index, patch) {
  if (!batchId) return;
  const key = `convertly:batch:${batchId}`;
  const raw = await redis.get(key);
  if (!raw) return;
  const batch = JSON.parse(raw);
  const item = batch.items?.[index];
  if (!item) return;
  Object.assign(item, patch);
  batch.completed = batch.items.filter(x => x.status === 'completed').length;
  batch.failed = batch.items.filter(x => x.status === 'failed').length;
  batch.status = batch.completed + batch.failed === batch.total
    ? (batch.failed ? 'completed_with_errors' : 'completed')
    : batch.items.some(x => x.status === 'processing')
      ? 'processing'
      : 'queued';
  await redis.set(key, JSON.stringify(batch), 'EX', Number(process.env.BATCH_TTL_SECONDS || 86400));
}

async function isCancelled(jobId) {
  try { return Boolean(await redis.get(`convertly:cancel:${jobId}`)); } catch { return false; }
}

const worker = new Worker('convertly-conversions', async job => {
  const { jobId, userId, url, quality, format, targetSizeMB, permissionConfirmed, maxDurationSeconds, guest, batchId, batchIndex, creditCost = 0 } = job.data;
  const dir = path.join(tempRoot, jobId);
  const rawOutput = path.join(dir, format === 'mp3' ? 'raw.mp3' : 'raw.mp4');
  const output = path.join(dir, format === 'mp3' ? 'output.mp3' : 'output.mp4');
  await mkdir(dir, { recursive: true });
  const startedAt = Date.now();
  await updateProgressMeta(jobId, 5, startedAt).catch(() => {});
  if (!guest && supabase) await supabase.from('conversions').update({ status: 'processing', progress: 5 }).eq('id', jobId).eq('user_id', userId);
  await updateBatch(batchId, batchIndex, { status: 'processing', progress: 5, etaSeconds: 0 }).catch(() => {});
  if (await isCancelled(jobId)) {
    await updateBatch(batchId, batchIndex, { status: 'cancelled', progress: 0, etaSeconds: 0, error: 'Cancelled by user.' }).catch(() => {});
    throw Object.assign(new Error('Conversion cancelled by user.'), { code: 'CONVERSION_CANCELLED' });
  }
  try {
    if (permissionConfirmed !== true) throw Object.assign(new Error('Permission confirmation is required before conversion.'), { code: 'PERMISSION_CONFIRMATION_REQUIRED' });
    const isMp3 = format === 'mp3';
    const durationFilter = maxDurationSeconds ? `duration <= ${Number(maxDurationSeconds)}` : '';
    const common = ['--no-playlist', '--no-warnings', ...(durationFilter ? ['--match-filter', durationFilter] : [])];
    const args = isMp3
      ? [...common, '-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', process.env.MP3_BITRATE || '192K', '--newline', '-o', rawOutput, url]
      : [...common, '-f', qualityFormat(quality), '--merge-output-format', 'mp4', '--newline', '-o', rawOutput, url];
    await run(process.env.YTDLP_BIN || 'yt-dlp', args, async p => {
      const progress = Math.min(90, Math.max(5, Math.round(p)));
      await job.updateProgress(progress).catch(() => {});
      const meta = await updateProgressMeta(jobId, progress, startedAt).catch(() => null);
      await updateBatch(batchId, batchIndex, { status: 'processing', progress, etaSeconds: meta?.etaSeconds ?? null }).catch(() => {});
      if (!guest && supabase) await supabase.from('conversions').update({ progress }).eq('id', jobId).eq('user_id', userId);
    }, jobId);
    if (!isMp3 && targetSizeMB) {
      await compressToTarget(rawOutput, output, targetSizeMB, async p => {
        await job.updateProgress(p).catch(() => {});
        const meta = await updateProgressMeta(jobId, p, startedAt).catch(() => null);
        await updateBatch(batchId, batchIndex, { status: 'processing', progress: p, etaSeconds: meta?.etaSeconds ?? null }).catch(() => {});
        if (!guest && supabase) await supabase.from('conversions').update({ progress: p }).eq('id', jobId).eq('user_id', userId);
      }, jobId);
      try { await stat(output); } catch { await import('node:fs/promises').then(m => m.copyFile(rawOutput, output)); }
    } else {
      await import('node:fs/promises').then(m => m.copyFile(rawOutput, output));
    }
    const extension = isMp3 ? 'mp3' : 'mp4';
    const expires = new Date(Date.now() + Number(process.env.DOWNLOAD_TTL_MINUTES || 30) * 60 * 1000).toISOString();
    if (localStorageMode) {
      const persistentOutput = guest
        ? path.join(guestOutputRoot, `${jobId}.${extension}`)
        : localOutputPath(userId, jobId, extension);
      await mkdir(path.dirname(persistentOutput), { recursive: true });
      await copyFile(output, persistentOutput);
      await job.updateProgress(100).catch(() => {});
      await updateProgressMeta(jobId, 100, startedAt).catch(() => {});
      await updateBatch(batchId, batchIndex, { status: 'completed', progress: 100, etaSeconds: 0, downloadUrl: `/api/download/${jobId}` }).catch(() => {});
      if (supabase && !guest) await supabase.from('conversions').update({ status: 'completed', progress: 100, output_path: localOutputKey(userId, jobId, extension), download_expires_at: expires, completed_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', userId);
      return persistentOutput;
    }
    const file = await readFile(output);
    if (!isR2Configured()) throw new Error('No output storage is configured. Enable LOCAL_FILE_STORAGE or configure R2.');
    const storagePath = `${userId}/${jobId}.${extension}`;
    await putR2Object(storagePath, file, isMp3 ? 'audio/mpeg' : 'video/mp4');
    await job.updateProgress(100).catch(() => {});
    await updateProgressMeta(jobId, 100, startedAt).catch(() => {});
    await updateBatch(batchId, batchIndex, { status: 'completed', progress: 100, etaSeconds: 0, downloadUrl: `/api/download/${jobId}` }).catch(() => {});
    if (supabase) await supabase.from('conversions').update({ status: 'completed', progress: 100, output_path: storagePath, download_expires_at: expires, completed_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', userId);
  } catch (error) {
    const cancelled = error?.code === 'CONVERSION_CANCELLED' || await isCancelled(jobId);
    const message = cancelled ? 'Cancelled by user.' : String(error.message || error).slice(0, 2000);
    if (!guest && supabase) {
      await supabase.from('conversions').update({ status: cancelled ? 'cancelled' : 'failed', error_message: message }).eq('id', jobId).eq('user_id', userId);
      if (creditCost > 0) await refundCredits(userId, creditCost, jobId);
    }
    await updateProgressMeta(jobId, 0, startedAt).catch(() => {});
    await updateBatch(batchId, batchIndex, { status: cancelled ? 'cancelled' : 'failed', progress: 0, etaSeconds: 0, error: message.slice(0, 500) }).catch(() => {});
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 1) });

worker.on('completed', job => console.log(`Completed ${job.id}`));
worker.on('failed', (job, err) => console.error(`Failed ${job?.id}:`, err.message));
console.log('Convertly worker started.');
