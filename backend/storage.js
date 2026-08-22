import { createClient } from '@supabase/supabase-js';

const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'convertly-files';
const supabaseStorage = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

export function isRemoteStorageConfigured() {
  return Boolean(supabaseStorage && bucket);
}

export async function putStoredObject(key, body, contentType) {
  if (!supabaseStorage) throw new Error('Supabase Storage is not configured.');
  const { error } = await supabaseStorage.storage.from(bucket).upload(key, body, {
    contentType,
    cacheControl: '3600',
    upsert: true
  });
  if (error) throw error;
}

export async function getStoredDownloadUrl(key, expiresIn = 900) {
  if (!supabaseStorage) throw new Error('Supabase Storage is not configured.');
  const { data, error } = await supabaseStorage.storage.from(bucket).createSignedUrl(key, expiresIn);
  if (error || !data?.signedUrl) throw error || new Error('Could not create Supabase Storage signed URL.');
  return data.signedUrl;
}

export async function deleteStoredObject(key) {
  if (!supabaseStorage) throw new Error('Supabase Storage is not configured.');
  const { error } = await supabaseStorage.storage.from(bucket).remove([key]);
  if (error) throw error;
}
