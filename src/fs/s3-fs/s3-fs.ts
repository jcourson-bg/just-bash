import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "../interface.js";
import { type S3Credentials, sign } from "./signing.js";

export interface S3FsOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  credentials: S3Credentials;
  prefix?: string;
  readOnly?: boolean;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  maxFileSize?: number;
}

/**
 * A filesystem backed by any S3-compatible object store.
 *
 * Works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, and anything
 * that speaks the S3 REST API. Pure TypeScript — signs requests with
 * AWS Signature V4 using Web Crypto, zero dependencies.
 *
 * @example
 * ```ts
 * const fs = new S3Fs({
 *   bucket: "my-data",
 *   region: "us-east-1",
 *   credentials: { accessKeyId: "AK…", secretAccessKey: "SK…" },
 * });
 *
 * await fs.writeFile("/report.csv", data);
 * const files = await fs.readdir("/");
 * ```
 */
export class S3Fs implements IFileSystem {
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly credentials: S3Credentials;
  private readonly prefix: string;
  private readonly readOnly: boolean;
  private readonly fetchFn: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly maxFileSize: number;

  constructor(options: S3FsOptions) {
    this.bucket = options.bucket;
    this.region = options.region ?? "us-east-1";
    this.endpoint =
      options.endpoint ?? `https://s3.${this.region}.amazonaws.com`;
    this.endpoint = this.endpoint.replace(/\/+$/, "");
    this.credentials = options.credentials;
    this.readOnly = options.readOnly ?? false;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxFileSize = options.maxFileSize ?? 10_485_760;

    let pfx = options.prefix ?? "";
    if (pfx.startsWith("/")) pfx = pfx.slice(1);
    if (pfx && !pfx.endsWith("/")) pfx = `${pfx}/`;
    this.prefix = pfx;
  }

  // ---------------------------------------------------------------------------
  // S3 HTTP layer
  // ---------------------------------------------------------------------------

  private objectUrl(key: string): string {
    const encoded = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `${this.endpoint}/${this.bucket}/${encoded}`;
  }

  private toKey(path: string): string {
    const p = normalizePath(path);
    const relative = p === "/" ? "" : p.slice(1);
    return `${this.prefix}${relative}`;
  }

  private async s3(
    method: string,
    url: string,
    body?: Uint8Array,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const parsed = new URL(url);
    const headers = await sign({
      method,
      url: parsed,
      region: this.region,
      credentials: this.credentials,
      body,
      headers: extraHeaders,
    });

    return this.fetchFn(url, {
      method,
      headers,
      body: body ? new Blob([body as BlobPart]) : null,
    });
  }

  private async s3OrThrow(
    method: string,
    url: string,
    op: string,
    path: string,
    body?: Uint8Array,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const resp = await this.s3(method, url, body, extraHeaders);
    if (resp.ok) return resp;

    if (resp.status === 404) throw fsError("ENOENT", op, path);
    if (resp.status === 403) throw fsError("EACCES", op, path);
    throw fsError("EIO", op, path);
  }

  private assertWritable(op: string, path: string): void {
    if (this.readOnly) throw fsError("EROFS", op, path);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async readFile(
    path: string,
    _options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buf = await this.readFileBuffer(path);
    return new TextDecoder().decode(buf);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const key = this.toKey(path);
    if (!key || key === this.prefix) throw fsError("EISDIR", "read", path);
    const url = this.objectUrl(key);
    const resp = await this.s3OrThrow("GET", url, "open", path);
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length > this.maxFileSize) throw fsError("EFBIG", "open", path);
    return buf;
  }

  async exists(path: string): Promise<boolean> {
    const key = this.toKey(path);

    // Root always exists
    if (!key || key === this.prefix) return true;

    // Try as file (HEAD)
    const headUrl = this.objectUrl(key);
    const headResp = await this.s3("HEAD", headUrl);
    if (headResp.ok) return true;

    // Try as directory (LIST with prefix + limit 1)
    const dirKey = key.endsWith("/") ? key : `${key}/`;
    return this.hasObjectsWithPrefix(dirKey);
  }

  async stat(path: string): Promise<FsStat> {
    const key = this.toKey(path);

    // Root
    if (!key || key === this.prefix) {
      return dirStat();
    }

    // Try as file (HEAD)
    const headUrl = this.objectUrl(key);
    const headResp = await this.s3("HEAD", headUrl);
    if (headResp.ok) {
      const size = Number.parseInt(
        headResp.headers.get("content-length") ?? "0",
        10,
      );
      const lastMod = headResp.headers.get("last-modified");
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size,
        mtime: lastMod ? new Date(lastMod) : new Date(),
      };
    }

    // Try as directory prefix
    const dirKey = key.endsWith("/") ? key : `${key}/`;
    if (await this.hasObjectsWithPrefix(dirKey)) {
      return dirStat();
    }

    throw fsError("ENOENT", "stat", path);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    const key = this.toKey(path);
    const prefix = key && !key.endsWith("/") ? `${key}/` : key;
    const entries = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const { files, prefixes, nextToken } = await this.listObjects(
        prefix,
        "/",
        continuationToken,
      );

      for (const f of files) {
        const name = f.key.slice(prefix.length);
        if (name && !name.includes("/")) entries.add(name);
      }
      for (const p of prefixes) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        if (name) entries.add(name);
      }

      continuationToken = nextToken;
    } while (continuationToken);

    if (entries.size === 0) {
      // Verify the "directory" exists at all
      if (prefix && prefix !== this.prefix) {
        const exists = await this.hasObjectsWithPrefix(prefix);
        if (!exists) throw fsError("ENOENT", "scandir", path);
      }
    }

    return Array.from(entries).sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const key = this.toKey(path);
    const prefix = key && !key.endsWith("/") ? `${key}/` : key;
    const fileNames = new Set<string>();
    const dirNames = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const { files, prefixes, nextToken } = await this.listObjects(
        prefix,
        "/",
        continuationToken,
      );

      for (const f of files) {
        const name = f.key.slice(prefix.length);
        if (name && !name.includes("/")) fileNames.add(name);
      }
      for (const p of prefixes) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        if (name) dirNames.add(name);
      }

      continuationToken = nextToken;
    } while (continuationToken);

    const out: DirentEntry[] = [];
    for (const name of fileNames) {
      if (!dirNames.has(name)) {
        out.push({
          name,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        });
      }
    }
    for (const name of dirNames) {
      out.push({
        name,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async realpath(path: string): Promise<string> {
    const p = normalizePath(path);
    const key = this.toKey(p);
    if (!key || key === this.prefix) return p;

    const url = this.objectUrl(key);
    const resp = await this.s3("HEAD", url);
    if (resp.ok) return p;

    const dirKey = key.endsWith("/") ? key : `${key}/`;
    if (await this.hasObjectsWithPrefix(dirKey)) return p;

    throw fsError("ENOENT", "realpath", path);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    const combined = base === "/" ? `/${path}` : `${base}/${path}`;
    return normalizePath(combined);
  }

  getAllPaths(): string[] {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.assertWritable("write", path);
    const key = this.toKey(path);
    if (!key || key === this.prefix || key.endsWith("/")) {
      throw fsError("EISDIR", "write", path);
    }
    const body: Uint8Array<ArrayBuffer> =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);
    if (body.length > this.maxFileSize) throw fsError("EFBIG", "write", path);
    const url = this.objectUrl(key);
    await this.s3OrThrow("PUT", url, "write", path, body);
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.assertWritable("append", path);
    let existing: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    try {
      existing = new Uint8Array(await this.readFileBuffer(path));
    } catch {
      // File doesn't exist — append creates it
    }
    const addition: Uint8Array<ArrayBuffer> =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);
    const combined = new Uint8Array(existing.length + addition.length);
    combined.set(existing);
    combined.set(addition, existing.length);
    await this.writeFile(path, combined);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    this.assertWritable("mkdir", path);
    const key = this.toKey(path);
    const dirKey = key.endsWith("/") ? key : `${key}/`;
    const url = this.objectUrl(dirKey);
    await this.s3OrThrow("PUT", url, "mkdir", path, new Uint8Array(0));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.assertWritable("rm", path);
    const key = this.toKey(path);

    // Try as file
    const headUrl = this.objectUrl(key);
    const headResp = await this.s3("HEAD", headUrl);
    if (headResp.ok) {
      await this.s3OrThrow("DELETE", headUrl, "rm", path);
      return;
    }

    // Try as directory
    const dirKey = key.endsWith("/") ? key : `${key}/`;
    const hasChildren = await this.hasObjectsWithPrefix(dirKey);

    if (!hasChildren) {
      if (options?.force) return;
      throw fsError("ENOENT", "rm", path);
    }

    if (!options?.recursive) {
      throw fsError("ENOTEMPTY", "rm", path);
    }

    // Delete all objects under this prefix
    let continuationToken: string | undefined;
    do {
      const { files, nextToken } = await this.listObjects(
        dirKey,
        undefined,
        continuationToken,
      );
      for (const f of files) {
        const delUrl = this.objectUrl(f.key);
        await this.s3("DELETE", delUrl);
      }
      continuationToken = nextToken;
    } while (continuationToken);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.assertWritable("cp", dest);
    const srcKey = this.toKey(src);
    const destKey = this.toKey(dest);

    // Check if src is a file
    const headUrl = this.objectUrl(srcKey);
    const headResp = await this.s3("HEAD", headUrl);

    if (headResp.ok) {
      // S3 server-side copy
      const url = this.objectUrl(destKey);
      await this.s3OrThrow("PUT", url, "cp", dest, undefined, {
        "x-amz-copy-source": `/${this.bucket}/${srcKey}`,
      });
      return;
    }

    // Directory copy
    if (!options?.recursive) throw fsError("EISDIR", "cp", src);
    const srcDir = srcKey.endsWith("/") ? srcKey : `${srcKey}/`;
    const destDir = destKey.endsWith("/") ? destKey : `${destKey}/`;
    let continuationToken: string | undefined;
    do {
      const { files, nextToken } = await this.listObjects(
        srcDir,
        undefined,
        continuationToken,
      );
      for (const f of files) {
        const relative = f.key.slice(srcDir.length);
        const newKey = `${destDir}${relative}`;
        const url = this.objectUrl(newKey);
        await this.s3OrThrow("PUT", url, "cp", dest, undefined, {
          "x-amz-copy-source": `/${this.bucket}/${f.key}`,
        });
      }
      continuationToken = nextToken;
    } while (continuationToken);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // S3 doesn't support POSIX permissions — silently accept
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    // S3 manages timestamps internally — silently accept
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw fsError("ENOTSUP", "symlink", linkPath);
  }

  async link(_existing: string, newPath: string): Promise<void> {
    throw fsError("ENOTSUP", "link", newPath);
  }

  async readlink(path: string): Promise<string> {
    throw fsError("EINVAL", "readlink", path);
  }

  // ---------------------------------------------------------------------------
  // S3 LIST helper
  // ---------------------------------------------------------------------------

  private async listObjects(
    prefix: string,
    delimiter?: string,
    continuationToken?: string,
  ): Promise<{
    files: Array<{ key: string; size: number; lastModified: string }>;
    prefixes: string[];
    nextToken: string | undefined;
  }> {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (delimiter) params.set("delimiter", delimiter);
    if (continuationToken) {
      params.set("continuation-token", continuationToken);
    }

    const url = `${this.endpoint}/${this.bucket}?${params}`;
    const resp = await this.s3OrThrow("GET", url, "scandir", `/${prefix}`);
    const xml = await resp.text();
    return parseListResponse(xml);
  }

  private async hasObjectsWithPrefix(prefix: string): Promise<boolean> {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix,
      "max-keys": "1",
    });
    const url = `${this.endpoint}/${this.bucket}?${params}`;
    const resp = await this.s3("GET", url);
    if (!resp.ok) return false;
    const xml = await resp.text();
    return xml.includes("<Contents>") || xml.includes("<CommonPrefixes>");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  let p = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/").filter((s) => s && s !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}` || "/";
}

function parseListResponse(xml: string): {
  files: Array<{ key: string; size: number; lastModified: string }>;
  prefixes: string[];
  nextToken: string | undefined;
} {
  const files: Array<{ key: string; size: number; lastModified: string }> = [];
  const prefixes: string[] = [];

  const contentsRe =
    /<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<LastModified>([\s\S]*?)<\/LastModified>[\s\S]*?<\/Contents>/g;
  for (const m of xml.matchAll(contentsRe)) {
    files.push({
      key: decodeXml(m[1]),
      size: Number.parseInt(m[2], 10),
      lastModified: m[3],
    });
  }

  const prefixRe =
    /<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g;
  for (const m of xml.matchAll(prefixRe)) {
    prefixes.push(decodeXml(m[1]));
  }

  const tokenMatch = xml.match(
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/,
  );
  const nextToken = tokenMatch ? decodeXml(tokenMatch[1]) : undefined;

  return { files, prefixes, nextToken };
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const ERROR_MESSAGES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    ENOENT: "no such file or directory",
    EISDIR: "illegal operation on a directory",
    ENOTDIR: "not a directory",
    EROFS: "read-only file system",
    EFBIG: "file too large",
    EIO: "input/output error",
    EINVAL: "invalid argument",
    EEXIST: "file already exists",
    EACCES: "permission denied",
    ENOTEMPTY: "directory not empty",
    ENOTSUP: "operation not supported",
  },
);

function fsError(code: string, op: string, path: string): Error {
  const msg = ERROR_MESSAGES[code] ?? code;
  return new Error(`${code}: ${msg}, ${op} '${path}'`);
}

function dirStat(): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o755,
    size: 0,
    mtime: new Date(),
  };
}
