/**
 * AWS Signature Version 4 signing for S3 requests.
 *
 * Pure TypeScript implementation using Web Crypto API (crypto.subtle).
 * Works in Node.js, Deno, Bun, and browsers — zero dependencies.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequest {
  method: string;
  url: URL;
  region: string;
  credentials: S3Credentials;
  body?: Uint8Array;
  headers?: Record<string, string>;
  date?: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

/**
 * Sign an HTTP request with AWS Signature V4.
 * Returns the complete set of headers to use (original + auth headers).
 */
export async function sign(req: SignRequest): Promise<Record<string, string>> {
  const now = req.date ?? new Date();
  const dateStamp = formatDate(now);
  const amzDate = formatAmzDate(now);
  const scope = `${dateStamp}/${req.region}/s3/aws4_request`;

  const payloadHash = req.body?.length
    ? await sha256Hex(req.body.buffer as ArrayBuffer)
    : EMPTY_HASH;

  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }
  headers.host = req.url.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = payloadHash;
  if (req.credentials.sessionToken) {
    headers["x-amz-security-token"] = req.credentials.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k].trim()}\n`)
    .join("");

  const canonicalQueryString = buildCanonicalQueryString(req.url);

  const canonicalRequest = [
    req.method,
    encodeUriPath(req.url.pathname),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest).buffer as ArrayBuffer),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    req.credentials.secretAccessKey,
    dateStamp,
    req.region,
  );

  const signature = await hmacHex(
    signingKey,
    encoder.encode(stringToSign).buffer as ArrayBuffer,
  );

  headers.authorization =
    `${ALGORITHM} Credential=${req.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

// ---------------------------------------------------------------------------
// Crypto primitives (Web Crypto API)
// ---------------------------------------------------------------------------

async function hmac(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, data);
}

async function hmacHex(key: ArrayBuffer, data: ArrayBuffer): Promise<string> {
  return hex(new Uint8Array(await hmac(key, data)));
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return hex(new Uint8Array(hash));
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(
    encoder.encode(`AWS4${secret}`).buffer as ArrayBuffer,
    encoder.encode(dateStamp).buffer as ArrayBuffer,
  );
  const kRegion = await hmac(
    kDate,
    encoder.encode(region).buffer as ArrayBuffer,
  );
  const kService = await hmac(
    kRegion,
    encoder.encode("s3").buffer as ArrayBuffer,
  );
  return hmac(kService, encoder.encode("aws4_request").buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function hex(buf: Uint8Array): string {
  let out = "";
  for (const b of buf) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatAmzDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function buildCanonicalQueryString(url: URL): string {
  const params = Array.from(url.searchParams.entries());
  if (params.length === 0) return "";
  return params
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join("&");
}

/**
 * URI-encode per AWS Sig V4 rules.
 * Encodes everything except A-Z a-z 0-9 - _ . ~
 */
function uriEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode the path component. Each segment is individually encoded
 * and slashes are preserved (not double-encoded).
 */
function encodeUriPath(path: string): string {
  return path
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/");
}
