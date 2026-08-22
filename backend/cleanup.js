import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const batch = Math.max(1, Number(process.env.CLEANUP_BATCH || 100));
const ttlMinutes = Math.max(1, Number(process.env.DOWNLOAD_TTL_MINUTES || 30));
const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
const tempRoot = process.env.TEMP_DIR || '/tmp/convertly';
const ephemeralOutputRoot = path.resolve(process.env.EPHEMERAL_OUTPUT_DIR || path.join(tempRoot, 'downloads'));

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

async function cleanupEphemeralFiles() {
  let removed = 0;
  try {
    const entries = await readdir(ephemeralOutputRoot, { withFileTypes: true });
    for (const entry of entries.slice(0, batch * 2)) {
      if (!entry.isFile()) continue;
      const filePath = path.join(ephemeralOutputRoot, entry.name);
      try {
        const info = await stat(filePath);
        if (info.mtime < cutoff) {
          await unlink(filePath);
          removed += 1;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Ephemeral cleanup failed:', filePath, error.message);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return removed;
}

async function expireDatabaseRows() {
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from('conversions')
    .select('id,output_path')
    .eq('status', 'completed')
    .lt('download_expires_at', new Date().toISOString())
    .like('output_path', 'ephemeral:%')
    .limit(batch);
  if (error) throw error;
  let expired = 0;
  for (const row of data || []) {
    const { error: updateError } = await supabase
      .from('conversions')
      .update({ status: 'expired', output_path: null })
      .eq('id', row.id);
    if (!updateError) expired += 1;
  }
  return expired;
}

const [removed, expired] = await Promise.all([cleanupEphemeralFiles(), expireDatabaseRows()]);
console.log(`Ephemeral cleanup complete: files removed=${removed}, database rows expired=${expired}.`);
