import crypto from 'node:crypto';

const S3_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function isValidBucketName(name) {
  return typeof name === 'string' && S3_BUCKET_RE.test(name) && !name.includes('..');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function signedS3Request({ method, endpoint, path = '/', query = '', accessKey, secretKey, body = '', headers = {} }) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}${path}${query ? `?${query}` : ''}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'us-east-1';
  const service = 's3';
  const payloadHash = sha256Hex(body);

  const canonicalHeadersObj = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };

  const sortedKeys = Object.keys(canonicalHeadersObj).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonicalHeadersObj[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const queryParams = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalUri = url.pathname.split('/').map(encodeRfc3986).join('/') || '/';
  const canonicalRequest = [method, canonicalUri, queryParams, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const reqHeaders = {
    ...canonicalHeadersObj,
    Authorization: authorization,
  };
  delete reqHeaders.host;

  const res = await fetch(url.toString(), {
    method,
    headers: reqHeaders,
    body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

export async function listMinioBuckets({ endpoint, accessKey, secretKey }) {
  const res = await signedS3Request({ method: 'GET', endpoint, path: '/', accessKey, secretKey });
  if (!res.ok) {
    throw new Error(`MinIO returned HTTP ${res.status}: ${res.text.slice(0, 140)}`);
  }
  const buckets = [];
  const bucketMatches = res.text.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g);
  for (const m of bucketMatches) {
    const inner = m[1];
    const nameMatch = inner.match(/<Name>(.*?)<\/Name>/);
    const dateMatch = inner.match(/<CreationDate>(.*?)<\/CreationDate>/);
    if (nameMatch?.[1]) {
      buckets.push({
        name: nameMatch[1],
        created_at: dateMatch?.[1] || null,
      });
    }
  }
  return buckets;
}

export async function createMinioBucket({ endpoint, accessKey, secretKey, bucketName, publicRead = false }) {
  const safeName = String(bucketName || '').trim().toLowerCase();
  if (!isValidBucketName(safeName)) {
    throw new Error('Bucket name must be 3-63 chars using lowercase letters, digits, and hyphens.');
  }

  const res = await signedS3Request({
    method: 'PUT',
    endpoint,
    path: `/${safeName}`,
    accessKey,
    secretKey,
  });

  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create MinIO bucket (${res.status}): ${res.text.slice(0, 140)}`);
  }

  if (publicRead) {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${safeName}/*`],
        },
      ],
    });
    const policyRes = await signedS3Request({
      method: 'PUT',
      endpoint,
      path: `/${safeName}`,
      query: 'policy=',
      accessKey,
      secretKey,
      body: policy,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!policyRes.ok) {
      throw new Error(`Bucket created cleanly, but public policy failed (${policyRes.status})`);
    }
  }

  return safeName;
}

export async function deleteMinioBucket({ endpoint, accessKey, secretKey, bucketName }) {
  const safeName = String(bucketName || '').trim().toLowerCase();
  if (!isValidBucketName(safeName)) {
    throw new Error('Invalid bucket name.');
  }

  const res = await signedS3Request({
    method: 'DELETE',
    endpoint,
    path: `/${safeName}`,
    accessKey,
    secretKey,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete bucket (${res.status}): Make sure the bucket is empty first.`);
  }
}
