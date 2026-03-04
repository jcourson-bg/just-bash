import { describe, expect, it, vi } from "vitest";
import { S3Fs } from "./s3-fs.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function xmlList(
  contents: Array<{ key: string; size: number }>,
  prefixes: string[] = [],
  nextToken?: string,
): string {
  const c = contents
    .map(
      (f) =>
        `<Contents><Key>${f.key}</Key><Size>${f.size}</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>`,
    )
    .join("");
  const p = prefixes
    .map((pr) => `<CommonPrefixes><Prefix>${pr}</Prefix></CommonPrefixes>`)
    .join("");
  const tok = nextToken
    ? `<NextContinuationToken>${nextToken}</NextContinuationToken>`
    : "";
  return `<?xml version="1.0"?><ListBucketResult>${c}${p}${tok}</ListBucketResult>`;
}

function createS3Fs(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  options?: { prefix?: string; readOnly?: boolean },
) {
  return new S3Fs({
    bucket: "test-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
    },
    fetch: handler,
    ...options,
  });
}

type ReqLog = Array<{ method: string; url: string; body?: string }>;

function mockS3(
  objects: Record<string, string>,
  opts?: { readOnly?: boolean; prefix?: string },
) {
  const store = new Map(Object.entries(objects));
  const log: ReqLog = [];

  const handler = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? await new Response(init.body).text() : undefined;
    log.push({ method, url, body });

    const parsed = new URL(url);
    const bucketAndKey = parsed.pathname.replace(/^\//, "");
    const slashIdx = bucketAndKey.indexOf("/");
    const key =
      slashIdx >= 0 ? decodeURIComponent(bucketAndKey.slice(slashIdx + 1)) : "";

    if (parsed.searchParams.has("list-type")) {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const delimiter = parsed.searchParams.get("delimiter");
      const maxKeys = Number.parseInt(
        parsed.searchParams.get("max-keys") ?? "1000",
        10,
      );

      const contents: Array<{ key: string; size: number }> = [];
      const prefixes: string[] = [];
      const seen = new Set<string>();

      for (const [k, v] of store) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);

        if (delimiter) {
          const slashIdx = rest.indexOf(delimiter);
          if (slashIdx >= 0) {
            const dir = prefix + rest.slice(0, slashIdx + 1);
            if (!seen.has(dir)) {
              seen.add(dir);
              prefixes.push(dir);
            }
            continue;
          }
        }
        if (rest) {
          contents.push({ key: k, size: v.length });
        }
        if (contents.length >= maxKeys) break;
      }

      return new Response(xmlList(contents, prefixes), { status: 200 });
    }

    if (method === "HEAD") {
      if (store.has(key)) {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(store.get(key)?.length),
            "last-modified": "Sat, 01 Jan 2024 00:00:00 GMT",
          },
        });
      }
      return new Response(null, { status: 404 });
    }

    if (method === "GET") {
      if (store.has(key)) {
        return new Response(store.get(key), { status: 200 });
      }
      return new Response("<Error><Code>NoSuchKey</Code></Error>", {
        status: 404,
      });
    }

    if (method === "PUT") {
      store.set(key, body ?? "");
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  });

  const fs = createS3Fs(handler, opts);
  return { fs, log, store, handler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("S3Fs", () => {
  describe("readFile", () => {
    it("reads a file from S3", async () => {
      const { fs } = mockS3({ "hello.txt": "Hello, S3!" });
      const content = await fs.readFile("/hello.txt");
      expect(content).toBe("Hello, S3!");
    });

    it("reads nested files", async () => {
      const { fs } = mockS3({ "a/b/c.txt": "deep" });
      expect(await fs.readFile("/a/b/c.txt")).toBe("deep");
    });

    it("throws ENOENT for missing files", async () => {
      const { fs } = mockS3({});
      await expect(fs.readFile("/nope.txt")).rejects.toThrow("ENOENT");
    });

    it("throws EISDIR for root", async () => {
      const { fs } = mockS3({});
      await expect(fs.readFile("/")).rejects.toThrow("EISDIR");
    });
  });

  describe("readFileBuffer", () => {
    it("returns binary content", async () => {
      const { fs } = mockS3({ "data.bin": "binary" });
      const buf = await fs.readFileBuffer("/data.bin");
      expect(new TextDecoder().decode(buf)).toBe("binary");
    });
  });

  describe("writeFile", () => {
    it("writes a file to S3", async () => {
      const { fs, store } = mockS3({});
      await fs.writeFile("/new.txt", "content");
      expect(store.get("new.txt")).toBe("content");
    });

    it("overwrites existing files", async () => {
      const { fs, store } = mockS3({ "f.txt": "old" });
      await fs.writeFile("/f.txt", "new");
      expect(store.get("f.txt")).toBe("new");
    });

    it("throws EROFS when readOnly", async () => {
      const { fs } = mockS3({}, { readOnly: true });
      await expect(fs.writeFile("/f.txt", "x")).rejects.toThrow("EROFS");
    });

    it("throws EISDIR for root path", async () => {
      const { fs } = mockS3({});
      await expect(fs.writeFile("/", "x")).rejects.toThrow("EISDIR");
    });
  });

  describe("appendFile", () => {
    it("appends to an existing file", async () => {
      const { fs, store } = mockS3({ "log.txt": "line1\n" });
      await fs.appendFile("/log.txt", "line2\n");
      expect(store.get("log.txt")).toBe("line1\nline2\n");
    });

    it("creates the file if it doesn't exist", async () => {
      const { fs, store } = mockS3({});
      await fs.appendFile("/new.txt", "first");
      expect(store.get("new.txt")).toBe("first");
    });
  });

  describe("exists", () => {
    it("returns true for existing files", async () => {
      const { fs } = mockS3({ "f.txt": "x" });
      expect(await fs.exists("/f.txt")).toBe(true);
    });

    it("returns false for missing files", async () => {
      const { fs } = mockS3({});
      expect(await fs.exists("/nope")).toBe(false);
    });

    it("returns true for root", async () => {
      const { fs } = mockS3({});
      expect(await fs.exists("/")).toBe(true);
    });

    it("returns true for directory prefixes", async () => {
      const { fs } = mockS3({ "dir/file.txt": "x" });
      expect(await fs.exists("/dir")).toBe(true);
    });
  });

  describe("stat", () => {
    it("returns file stats from HEAD response", async () => {
      const { fs } = mockS3({ "f.txt": "hello" });
      const s = await fs.stat("/f.txt");
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.size).toBe(5);
    });

    it("returns directory stats for prefixes", async () => {
      const { fs } = mockS3({ "dir/f.txt": "x" });
      const s = await fs.stat("/dir");
      expect(s.isFile).toBe(false);
      expect(s.isDirectory).toBe(true);
    });

    it("returns directory stats for root", async () => {
      const { fs } = mockS3({});
      const s = await fs.stat("/");
      expect(s.isDirectory).toBe(true);
    });

    it("throws ENOENT for missing paths", async () => {
      const { fs } = mockS3({});
      await expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("readdir", () => {
    it("lists files and directories", async () => {
      const { fs } = mockS3({
        "a.txt": "a",
        "b.txt": "b",
        "sub/c.txt": "c",
      });
      const entries = await fs.readdir("/");
      expect(entries).toEqual(["a.txt", "b.txt", "sub"]);
    });

    it("lists nested directory contents", async () => {
      const { fs } = mockS3({
        "dir/x.txt": "x",
        "dir/y.txt": "y",
      });
      expect(await fs.readdir("/dir")).toEqual(["x.txt", "y.txt"]);
    });

    it("throws ENOENT for missing directories", async () => {
      const { fs } = mockS3({});
      await expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("readdirWithFileTypes", () => {
    it("distinguishes files from directories", async () => {
      const { fs } = mockS3({
        "f.txt": "file",
        "dir/nested.txt": "nested",
      });
      const entries = await fs.readdirWithFileTypes("/");
      expect(entries).toEqual([
        {
          name: "dir",
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        },
        {
          name: "f.txt",
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        },
      ]);
    });
  });

  describe("rm", () => {
    it("deletes a file", async () => {
      const { fs, store } = mockS3({ "f.txt": "x" });
      await fs.rm("/f.txt");
      expect(store.has("f.txt")).toBe(false);
    });

    it("throws ENOENT for missing files", async () => {
      const { fs } = mockS3({});
      await expect(fs.rm("/nope")).rejects.toThrow("ENOENT");
    });

    it("force option suppresses ENOENT", async () => {
      const { fs } = mockS3({});
      await expect(fs.rm("/nope", { force: true })).resolves.toBeUndefined();
    });

    it("recursively deletes directory contents", async () => {
      const { fs, store } = mockS3({
        "dir/a.txt": "a",
        "dir/b.txt": "b",
        "dir/sub/c.txt": "c",
      });
      await fs.rm("/dir", { recursive: true });
      expect(store.size).toBe(0);
    });

    it("throws ENOTEMPTY without recursive", async () => {
      const { fs } = mockS3({ "dir/a.txt": "a" });
      await expect(fs.rm("/dir")).rejects.toThrow("ENOTEMPTY");
    });

    it("throws EROFS when readOnly", async () => {
      const { fs } = mockS3({ "f.txt": "x" }, { readOnly: true });
      await expect(fs.rm("/f.txt")).rejects.toThrow("EROFS");
    });
  });

  describe("cp", () => {
    it("copies a file using S3 server-side copy", async () => {
      const { fs, store, log } = mockS3({ "src.txt": "data" });
      await fs.cp("/src.txt", "/dst.txt");
      expect(store.has("dst.txt")).toBe(true);
      const copyReq = log.find(
        (r) => r.method === "PUT" && r.url.includes("dst.txt"),
      );
      expect(copyReq).toBeDefined();
    });

    it("copies directories recursively", async () => {
      const { fs, store } = mockS3({
        "src/a.txt": "a",
        "src/b.txt": "b",
      });
      await fs.cp("/src", "/dst", { recursive: true });
      expect(store.has("dst/a.txt")).toBe(true);
      expect(store.has("dst/b.txt")).toBe(true);
    });
  });

  describe("mv", () => {
    it("moves a file (copy + delete)", async () => {
      const { fs, store } = mockS3({ "old.txt": "data" });
      await fs.mv("/old.txt", "/new.txt");
      expect(store.has("new.txt")).toBe(true);
      expect(store.has("old.txt")).toBe(false);
    });
  });

  describe("mkdir", () => {
    it("creates a directory marker object", async () => {
      const { fs, store } = mockS3({});
      await fs.mkdir("/newdir");
      expect(store.has("newdir/")).toBe(true);
    });
  });

  describe("prefix option", () => {
    it("scopes all operations under the prefix", async () => {
      const { fs } = mockS3({ "data/file.txt": "content" }, { prefix: "data" });
      const content = await fs.readFile("/file.txt");
      expect(content).toBe("content");
    });

    it("readdir works under prefix", async () => {
      const { fs } = mockS3(
        { "data/a.txt": "a", "data/b.txt": "b", "other/c.txt": "c" },
        { prefix: "data" },
      );
      const entries = await fs.readdir("/");
      expect(entries).toEqual(["a.txt", "b.txt"]);
    });

    it("writeFile goes under prefix", async () => {
      const { fs, store } = mockS3({}, { prefix: "out" });
      await fs.writeFile("/result.txt", "done");
      expect(store.has("out/result.txt")).toBe(true);
    });
  });

  describe("unsupported operations", () => {
    it("symlink throws ENOTSUP", async () => {
      const { fs } = mockS3({});
      await expect(fs.symlink("/a", "/b")).rejects.toThrow("ENOTSUP");
    });

    it("link throws ENOTSUP", async () => {
      const { fs } = mockS3({});
      await expect(fs.link("/a", "/b")).rejects.toThrow("ENOTSUP");
    });

    it("readlink throws EINVAL", async () => {
      const { fs } = mockS3({ "f.txt": "x" });
      await expect(fs.readlink("/f.txt")).rejects.toThrow("EINVAL");
    });

    it("chmod is a no-op", async () => {
      const { fs } = mockS3({ "f.txt": "x" });
      await expect(fs.chmod("/f.txt", 0o777)).resolves.toBeUndefined();
    });

    it("utimes is a no-op", async () => {
      const { fs } = mockS3({ "f.txt": "x" });
      const now = new Date();
      await expect(fs.utimes("/f.txt", now, now)).resolves.toBeUndefined();
    });
  });

  describe("resolvePath", () => {
    it("resolves absolute paths", () => {
      const { fs } = mockS3({});
      expect(fs.resolvePath("/foo", "/bar")).toBe("/bar");
    });

    it("resolves relative paths", () => {
      const { fs } = mockS3({});
      expect(fs.resolvePath("/foo", "bar")).toBe("/foo/bar");
    });
  });
});
