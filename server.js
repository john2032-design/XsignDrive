import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import {PassThrough, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
  S3Client, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand
} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 10000);
const BUCKET = process.env.S3_BUCKET || process.env.TIGRIS_BUCKET || '';
const REGION = process.env.AWS_REGION || 'auto';
const ENDPOINT = process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL || 'https://t3.storage.dev';
const MAX_IPA_BYTES = positiveInteger(process.env.MAX_IPA_BYTES, 4 * 1024 ** 3, 1, 20 * 1024 ** 3);
const IPA_URL_TTL_SECONDS = positiveInteger(process.env.IPA_URL_TTL_SECONDS, 86400, 60, 7 * 86400);
const UPLOAD_RATE_LIMIT = positiveInteger(process.env.UPLOAD_RATE_LIMIT, 5, 1, 1000);
const UPLOAD_RATE_WINDOW_MS = positiveInteger(process.env.UPLOAD_RATE_WINDOW_MS, 900000, 60000, 86400000);
const CLEANUP_INTERVAL_MS = positiveInteger(process.env.CLEANUP_INTERVAL_MS, 900000, 60000, 86400000);
const PART_SIZE_BYTES = positiveInteger(process.env.PART_SIZE_BYTES, 32 * 1024 ** 2, 5 * 1024 ** 2, 512 * 1024 ** 2);
const META_PREFIX = 'xsigndrive-meta/';
const FILE_PREFIX = 'xsigndrive/';

let s3Client;
function positiveInteger(value, fallback, min, max) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function storageConfigured() {
  return Boolean(BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && ENDPOINT && REGION);
}
function getS3() {
  if (!storageConfigured()) throw new Error('Tigris storage is not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to the same credentials used by xsigner.');
  if (!s3Client) {
    s3Client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: false,
      credentials: {accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY},
      maxAttempts: 4
    });
  }
  return s3Client;
}
function cleanFilename(raw) {
  const base = path.basename(String(raw || 'app.ipa').replaceAll('\\', '/')).normalize('NFKC');
  let name = base.replace(/[^A-Za-z0-9._()+ -]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 160);
  if (!name || name === '.' || name === '..') name = 'app.ipa';
  if (!name.toLowerCase().endsWith('.ipa')) name = `${name.replace(/\.[^.]*$/, '') || 'app'}.ipa`;
  return name;
}
function safeHeaderFilename(value) {
  return String(value || 'signed-app.ipa').replace(/["\\\r\n]/g, '_').slice(0, 180);
}
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
function jsonError(res, status, code, error, extra = {}) {
  return res.status(status).set('Cache-Control', 'no-store').json({success: false, ok: false, code, error, ...extra});
}
function metadataKey(id) { return `${META_PREFIX}${id}.json`; }
function newUploadId() { return crypto.randomBytes(9).toString('base64url'); }
async function deleteObject(key) {
  if (!key || !storageConfigured()) return;
  try { await getS3().send(new DeleteObjectCommand({Bucket: BUCKET, Key: key})); }
  catch (error) { console.warn('XsignDrive object cleanup failed:', error?.name || 'storage error'); }
}

// Custom Multer storage streams the incoming IPA to Tigris without buffering it in RAM or on disk.
const ipaStorage = {
  _handleFile(_req, file, callback) {
    const filename = cleanFilename(file.originalname);
    const id = newUploadId();
    const key = `${FILE_PREFIX}${id}/${filename}`;
    const pass = new PassThrough();
    let size = 0;
    let callbackCalled = false;
    const finish = (error, info) => {
      if (callbackCalled) return;
      callbackCalled = true;
      callback(error, info);
    };
    const counter = new Transform({transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > MAX_IPA_BYTES) return done(Object.assign(new Error(`IPA exceeds the ${formatBytes(MAX_IPA_BYTES)} upload limit.`), {status: 413, code: 'IPA_TOO_LARGE'}));
      done(null, chunk);
    }});
    let uploader;
    try {
      uploader = new Upload({
        client: getS3(),
        params: {Bucket: BUCKET, Key: key, Body: pass, ContentType: 'application/octet-stream', Metadata: {uploadid: id, app: 'xsigndrive'}},
        queueSize: 2, partSize: PART_SIZE_BYTES, leavePartsOnError: false
      });
    } catch (error) {
      return finish(error);
    }
    const uploadPromise = uploader.done();
    uploadPromise.catch(error => pass.destroy(error));
    pipeline(file.stream, counter, pass)
      .then(() => uploadPromise)
      .then(() => finish(null, {id, key, filename, size, contentType: 'application/octet-stream'}))
      .catch(async error => {
        pass.destroy(error);
        await uploadPromise.catch(() => {});
        await deleteObject(key);
        finish(Object.assign(error, {status: error?.status || (error?.code === 'IPA_TOO_LARGE' ? 413 : 502)}));
      });
  },
  _removeFile(_req, file, callback) {
    deleteObject(file.key).then(() => callback(null), callback);
  }
};
const ipaUpload = multer({
  storage: ipaStorage,
  limits: {fileSize: MAX_IPA_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32, fieldSize: 1},
  fileFilter(_req, file, callback) {
    if (file.fieldname !== 'ipa') return callback(Object.assign(new Error('Upload one file using the ipa field.'), {status: 400, code: 'INVALID_FIELD'}));
    if (path.extname(file.originalname || '').toLowerCase() !== '.ipa') return callback(Object.assign(new Error('Only .ipa files are accepted.'), {status: 400, code: 'INVALID_FILE_TYPE'}));
    callback(null, true);
  }
});

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", 'https://i.ibb.co', 'data:'],
    styleSrc: ["'self'"],
    scriptSrc: ["'self'"],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: []
  }}
}));
app.use(express.json({limit: '32kb'}));
app.use(express.static(path.join(process.cwd(), 'public'), {maxAge: '1h', etag: true, setHeaders(res, filePath) {
  if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store, max-age=0');
}}));

const uploadLimiter = rateLimit({
  windowMs: UPLOAD_RATE_WINDOW_MS,
  limit: UPLOAD_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {success: false, ok: false, code: 'UPLOAD_RATE_LIMITED', error: 'Too many uploads from this IP. Try again after the rate-limit window resets.'}
});

app.get('/healthz', (_req, res) => {
  const configured = storageConfigured();
  return res.status(configured ? 200 : 503).set('Cache-Control', 'no-store').json({
    ok: configured,
    status: configured ? 'ok' : 'degraded',
    service: 'xsigndrive',
    storage: configured ? 'tigris-configured' : 'unconfigured'
  });
});
app.get('/api/config', (_req, res) => res.set('Cache-Control', 'no-store').json({
  maxIpaBytes: MAX_IPA_BYTES,
  maxIpaLabel: formatBytes(MAX_IPA_BYTES),
  urlTtlSeconds: IPA_URL_TTL_SECONDS,
  urlTtlLabel: IPA_URL_TTL_SECONDS >= 86400 ? `${Math.round(IPA_URL_TTL_SECONDS / 86400)} day${IPA_URL_TTL_SECONDS >= 172800 ? 's' : ''}` : `${Math.round(IPA_URL_TTL_SECONDS / 3600)} hours`,
  uploadRateLimit: UPLOAD_RATE_LIMIT,
  uploadRateWindowMs: UPLOAD_RATE_WINDOW_MS
}));

async function redirectToIpa(req, res) {
  const {id, filename} = req.params;
  if (!/^[A-Za-z0-9_-]{12}$/.test(id) || !filename || !filename.toLowerCase().endsWith('.ipa')) {
    return jsonError(res, 404, 'NOT_FOUND', 'IPA link not found or expired.');
  }
  if (!storageConfigured()) return jsonError(res, 503, 'STORAGE_NOT_CONFIGURED', 'XsignDrive storage is not configured.');
  try {
    const result = await getS3().send(new GetObjectCommand({Bucket: BUCKET, Key: metadataKey(id)}));
    const meta = JSON.parse(await result.Body.transformToString());
    const expectedFilename = String(meta.filename || '').replace(/\.ipa$/i, '.ipa');
    if (!meta.key || !meta.filename || filename !== expectedFilename) {
      return jsonError(res, 404, 'NOT_FOUND', 'IPA link not found or expired.');
    }
    const expiresAtMs = Date.parse(meta.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return jsonError(res, 410, 'LINK_EXPIRED', 'This IPA link has expired. Upload the file again to create a new link.');
    }
    const remainingSeconds = Math.floor((expiresAtMs - Date.now()) / 1000);
    const signedUrl = await getSignedUrl(getS3(), new GetObjectCommand({
      Bucket: BUCKET, Key: meta.key,
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: `attachment; filename="${safeHeaderFilename(meta.filename)}"`
    }), {expiresIn: Math.max(1, Math.min(IPA_URL_TTL_SECONDS, remainingSeconds))});
    return res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(302, signedUrl);
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      return jsonError(res, 404, 'NOT_FOUND', 'IPA link not found or expired.');
    }
    console.warn('XsignDrive could not resolve an IPA link:', error?.name || 'storage error');
    return jsonError(res, 502, 'DOWNLOAD_LINK_FAILED', 'Could not prepare the IPA download right now. Please retry.');
  }
}
app.get('/d/:id/:filename', redirectToIpa);
app.get('/', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.post('/api/uploads', uploadLimiter, (req, res, next) => {
  if (!storageConfigured()) return jsonError(res, 503, 'STORAGE_NOT_CONFIGURED', 'XsignDrive storage is not configured yet.');
  ipaUpload.single('ipa')(req, res, async error => {
    if (error) {
      const status = Number(error.status) || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      const code = error.code === 'LIMIT_FILE_SIZE' ? 'IPA_TOO_LARGE' : (error.code || 'INVALID_UPLOAD');
      return jsonError(res, status, code, status === 413 ? `IPA exceeds the ${formatBytes(MAX_IPA_BYTES)} upload limit.` : (error.message || 'Invalid IPA upload.'));
    }
    const file = req.file;
    if (!file) return jsonError(res, 400, 'IPA_REQUIRED', 'Choose an .ipa file to upload.');
    try {
      const createdAt = Date.now();
      const expiresAtMs = createdAt + IPA_URL_TTL_SECONDS * 1000;
      const meta = {id: file.id, key: file.key, filename: file.filename, size: file.size, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAtMs).toISOString()};
      await getS3().send(new PutObjectCommand({
        Bucket: BUCKET, Key: metadataKey(file.id), Body: JSON.stringify(meta),
        ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store'
      }));
      const publicBase = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const linkFilename = file.filename.replace(/\.ipa$/i, '.ipa');
      const ipaUrl = `${publicBase}/d/${file.id}/${encodeURIComponent(linkFilename)}`;
      return res.status(201).set('Cache-Control', 'no-store').json({
        success: true, ok: true, id: file.id, fileName: file.filename, fileSize: file.size,
        fileSizeFormatted: formatBytes(file.size), uploadedAt: meta.createdAt,
        expiresAt: meta.expiresAt, urlTtlSeconds: IPA_URL_TTL_SECONDS,
        ipaUrl, url: ipaUrl,
        message: 'IPA uploaded. Use ipaUrl as the source URL in xsigner.'
      });
    } catch (error) {
      await deleteObject(file.key);
      console.error('XsignDrive could not finish upload:', error?.name || 'storage error');
      return jsonError(res, 502, 'UPLOAD_FINALIZATION_FAILED', 'The IPA reached storage, but XsignDrive could not create its expiring link. Please retry.');
    }
  });
});

async function cleanupExpiredUploads() {
  if (!storageConfigured()) return;
  try {
    let continuationToken;
    do {
      const result = await getS3().send(new ListObjectsV2Command({Bucket: BUCKET, Prefix: META_PREFIX, ContinuationToken: continuationToken, MaxKeys: 500}));
      for (const object of result.Contents || []) {
        if (!object.Key || !object.Key.endsWith('.json')) continue;
        try {
          const response = await getS3().send(new GetObjectCommand({Bucket: BUCKET, Key: object.Key}));
          const meta = JSON.parse(await response.Body.transformToString());
          if (!meta.expiresAt || Date.parse(meta.expiresAt) <= Date.now()) {
            await deleteObject(meta.key);
            await deleteObject(object.Key);
          }
        } catch (error) {
          console.warn('XsignDrive cleanup skipped a metadata record:', error?.name || 'storage error');
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    console.warn('XsignDrive expiry sweep failed:', error?.name || 'storage error');
  }
}

app.use((req, res) => jsonError(res, 404, 'NOT_FOUND', 'Endpoint not found.'));
app.use((error, _req, res, _next) => {
  console.error('XsignDrive request failed:', error?.name || 'unexpected error');
  if (res.headersSent) return;
  const status = Number(error?.status) || 500;
  if (error?.code === 'LIMIT_FILE_SIZE' || error?.code === 'IPA_TOO_LARGE') return jsonError(res, 413, 'IPA_TOO_LARGE', `IPA exceeds the ${formatBytes(MAX_IPA_BYTES)} upload limit.`);
  return jsonError(res, status >= 400 && status <= 599 ? status : 500, 'REQUEST_FAILED', status < 500 ? 'Invalid request.' : 'XsignDrive could not process the request. Retry shortly.');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`XsignDrive listening on 0.0.0.0:${PORT}; Tigris configured=${storageConfigured()}; IPA URL TTL=${IPA_URL_TTL_SECONDS}s`);
  void cleanupExpiredUploads();
});
const cleanupTimer = setInterval(() => void cleanupExpiredUploads(), CLEANUP_INTERVAL_MS).unref();
async function shutdown() {
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 25_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
