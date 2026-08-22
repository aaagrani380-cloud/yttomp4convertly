import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const bucket = process.env.R2_BUCKET || 'convertly-files';

export function isR2Configured() {
  return Boolean(endpoint && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && bucket);
}

export function getR2Bucket() { return bucket; }

let client;
export function getR2Client() {
  if (!isR2Configured()) throw new Error('R2 storage is not configured. Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET.');
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
    });
  }
  return client;
}

export async function putR2Object(key, body, contentType) {
  await getR2Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getR2DownloadUrl(key, expiresIn = 900) {
  return getSignedUrl(getR2Client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function deleteR2Object(key) {
  await getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
