import { describe, expect, it } from "vitest";
import { sign } from "./signing.js";

const TEST_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const TEST_DATE = new Date("2013-05-24T00:00:00Z");

describe("AWS Signature V4 signing", () => {
  it("signs a GET request with correct Authorization header format", async () => {
    const headers = await sign({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
    });

    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("includes host in signed headers", async () => {
    const headers = await sign({
      method: "GET",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
    });

    expect(headers.host).toBe("s3.us-east-1.amazonaws.com");
    expect(headers.authorization).toContain("SignedHeaders=");
    expect(headers.authorization).toContain("host");
  });

  it("hashes the payload for PUT requests", async () => {
    const body = new TextEncoder().encode("Hello, S3!");
    const headers = await sign({
      method: "PUT",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      body,
      date: TEST_DATE,
    });

    // Should not be the empty hash
    expect(headers["x-amz-content-sha256"]).not.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("uses empty hash for bodyless requests", async () => {
    const headers = await sign({
      method: "DELETE",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
    });

    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("includes session token when provided", async () => {
    const headers = await sign({
      method: "GET",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: { ...TEST_CREDS, sessionToken: "FwoGZX..." },
      date: TEST_DATE,
    });

    expect(headers["x-amz-security-token"]).toBe("FwoGZX...");
    expect(headers.authorization).toContain("x-amz-security-token");
  });

  it("produces deterministic signatures for the same inputs", async () => {
    const args = {
      method: "GET" as const,
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
    };

    const h1 = await sign(args);
    const h2 = await sign(args);

    expect(h1.authorization).toBe(h2.authorization);
  });

  it("produces different signatures for different regions", async () => {
    const base = {
      method: "GET" as const,
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      credentials: TEST_CREDS,
      date: TEST_DATE,
    };

    const h1 = await sign({ ...base, region: "us-east-1" });
    const h2 = await sign({ ...base, region: "eu-west-1" });

    expect(h1.authorization).not.toBe(h2.authorization);
  });

  it("handles query parameters in the canonical request", async () => {
    const headers = await sign({
      method: "GET",
      url: new URL(
        "https://s3.us-east-1.amazonaws.com/bucket?list-type=2&prefix=data/",
      ),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
    });

    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}/);
  });

  it("passes extra headers through and includes them in signing", async () => {
    const headers = await sign({
      method: "PUT",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/dest"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
      headers: { "x-amz-copy-source": "/bucket/src" },
    });

    expect(headers["x-amz-copy-source"]).toBe("/bucket/src");
    expect(headers.authorization).toContain("x-amz-copy-source");
  });

  it("sorts signed headers alphabetically", async () => {
    const headers = await sign({
      method: "GET",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      region: "us-east-1",
      credentials: TEST_CREDS,
      date: TEST_DATE,
      headers: { "x-custom-z": "z", "x-custom-a": "a" },
    });

    const match = headers.authorization.match(/SignedHeaders=([^,]+)/);
    expect(match).not.toBeNull();
    const signed = match?.[1]?.split(";") ?? [];
    expect(signed.length).toBeGreaterThan(0);

    for (let i = 1; i < signed.length; i++) {
      expect(signed[i] >= signed[i - 1]).toBe(true);
    }
  });
});
