import { describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { mount } from "../mount.js";
import { S3Fs } from "./s3-fs.js";

function xmlList(
  contents: Array<{ key: string; size: number }>,
  prefixes: string[] = [],
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
  return `<?xml version="1.0"?><ListBucketResult>${c}${p}</ListBucketResult>`;
}

function mockS3Store(objects: Record<string, string>) {
  const store = new Map(Object.entries(objects));

  const handler = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? await new Response(init.body).text() : undefined;
    const parsed = new URL(url);
    const bucketAndKey = parsed.pathname.replace(/^\//, "");
    const slashIdx = bucketAndKey.indexOf("/");
    const key =
      slashIdx >= 0 ? decodeURIComponent(bucketAndKey.slice(slashIdx + 1)) : "";

    if (parsed.searchParams.has("list-type")) {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const delimiter = parsed.searchParams.get("delimiter");
      const contents: Array<{ key: string; size: number }> = [];
      const prefixes: string[] = [];
      const seen = new Set<string>();
      for (const [k, v] of store) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (delimiter) {
          const si = rest.indexOf(delimiter);
          if (si >= 0) {
            const dir = prefix + rest.slice(0, si + 1);
            if (!seen.has(dir)) {
              seen.add(dir);
              prefixes.push(dir);
            }
            continue;
          }
        }
        if (rest) contents.push({ key: k, size: v.length });
      }
      return new Response(xmlList(contents, prefixes), { status: 200 });
    }

    if (method === "HEAD") {
      return store.has(key)
        ? new Response(null, {
            status: 200,
            headers: {
              "content-length": String(store.get(key)?.length),
              "last-modified": "Sat, 01 Jan 2024 00:00:00 GMT",
            },
          })
        : new Response(null, { status: 404 });
    }

    if (method === "GET") {
      return store.has(key)
        ? new Response(store.get(key), { status: 200 })
        : new Response("", { status: 404 });
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

  return { handler, store };
}

describe("S3Fs + mount() + Bash", () => {
  it("cat a file from S3 mount", async () => {
    const { handler } = mockS3Store({ "data/report.csv": "a,b,c\n1,2,3\n" });

    const fs = mount({
      "/s3": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        prefix: "data",
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec("cat /s3/report.csv");
    expect(r.stdout).toBe("a,b,c\n1,2,3\n");
    expect(r.exitCode).toBe(0);
  });

  it("ls lists S3 contents", async () => {
    const { handler } = mockS3Store({
      "alpha.txt": "a",
      "beta.txt": "b",
    });

    const fs = mount({
      "/bucket": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec("ls /bucket");
    expect(r.stdout).toBe("alpha.txt\nbeta.txt\n");
    expect(r.exitCode).toBe(0);
  });

  it("grep through S3 files", async () => {
    const { handler } = mockS3Store({
      "log.txt": "INFO: ok\nERROR: bad\nINFO: done\n",
    });

    const fs = mount({
      "/logs": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec("grep ERROR /logs/log.txt");
    expect(r.stdout).toBe("ERROR: bad\n");
    expect(r.exitCode).toBe(0);
  });

  it("pipe S3 content through sort", async () => {
    const { handler } = mockS3Store({ "nums.txt": "3\n1\n2\n" });

    const fs = mount({
      "/data": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec("cat /data/nums.txt | sort");
    expect(r.stdout).toBe("1\n2\n3\n");
    expect(r.exitCode).toBe(0);
  });

  it("cross-mount: read from S3, write to local", async () => {
    const { handler } = mockS3Store({ "source.txt": "from s3" });

    const fs = mount({
      "/s3": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec(
      "cat /s3/source.txt > /tmp/local.txt && cat /tmp/local.txt",
    );
    expect(r.stdout).toBe("from s3");
    expect(r.exitCode).toBe(0);
  });

  it("write to S3 mount and read back", async () => {
    const { handler, store } = mockS3Store({});

    const fs = mount({
      "/s3": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const w = await bash.exec('echo "hello s3" > /s3/output.txt');
    expect(w.exitCode).toBe(0);
    expect(store.has("output.txt")).toBe(true);

    const r = await bash.exec("cat /s3/output.txt");
    expect(r.stdout).toBe("hello s3\n");
    expect(r.exitCode).toBe(0);
  });

  it("wc -l on S3 content", async () => {
    const { handler } = mockS3Store({
      "data.csv": "a,b\n1,2\n3,4\n5,6\n",
    });

    const fs = mount({
      "/data": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
      }),
    });

    const bash = new Bash({ fs });
    const r = await bash.exec("wc -l /data/data.csv");
    expect(r.stdout).toBe("4 /data/data.csv\n");
    expect(r.exitCode).toBe(0);
  });

  it("readOnly S3 mount rejects writes gracefully", async () => {
    const { handler } = mockS3Store({ "readme.txt": "read only" });

    const fs = mount({
      "/ro": new S3Fs({
        bucket: "test",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
        fetch: handler,
        readOnly: true,
      }),
    });

    const bash = new Bash({ fs });

    const r = await bash.exec("cat /ro/readme.txt");
    expect(r.stdout).toBe("read only");
    expect(r.exitCode).toBe(0);

    const w = await bash.exec("echo nope > /ro/readme.txt");
    expect(w.stderr).toContain("Read-only file system");
    expect(w.exitCode).toBe(1);
  });
});
