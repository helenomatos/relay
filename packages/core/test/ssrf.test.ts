import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from "../src/ssrf";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("assertPublicUrl", () => {
  it("rejects cloud metadata", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects localhost by name", async () => {
    await expect(assertPublicUrl("http://localhost:5432")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow("only http(s)");
    await expect(assertPublicUrl("https://user:pw@8.8.8.8/")).rejects.toThrow("credentials");
  });

  it("accepts a public IP literal", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/hook")).resolves.toBeUndefined();
  });
});
