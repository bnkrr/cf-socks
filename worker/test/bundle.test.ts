import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bundleDir = ".local/test-bundles";

describe("worker profile bundles", () => {
  it("builds full with every current worker module family", () => {
    const { inputs, code } = buildProfile("full");
    expect(inputs).toContain("worker/src/profiles/full.ts");
    expect(inputs).toContain("worker/src/auth/bearer-claims.ts");
    expect(inputs).toContain("worker/src/auth/static-bearer.ts");
    expect(inputs).toContain("worker/src/ingress/direct-path.ts");
    expect(inputs).toContain("worker/src/ingress/target-url.ts");
    expect(inputs).toContain("worker/src/ingress/meta.ts");
    expect(inputs).toContain("worker/src/egress/fetch.ts");
    expect(inputs).toContain("worker/src/response/wss-tunnel.ts");
    expect(inputs).toContain("worker/src/response/payload-stream.ts");
    expect(code).toContain("/wss");
    expect(code).toContain("/direct/");
    expect(code).toContain("/direct-url");
    expect(code).toContain("/__meta");
  });

  it("builds wss-only without direct or payload-only modules", () => {
    const { inputs, code } = buildProfile("wss-only");
    expect(inputs).toContain("worker/src/profiles/wss-only.ts");
    expect(inputs).toContain("worker/src/auth/bearer-claims.ts");
    expect(inputs).toContain("worker/src/response/wss-tunnel.ts");
    expect(inputs).toContain("worker/src/egress/connect.ts");
    expect(inputs).not.toContain("worker/src/auth/static-bearer.ts");
    expect(inputs).not.toContain("worker/src/ingress/direct-path.ts");
    expect(inputs).not.toContain("worker/src/ingress/target-url.ts");
    expect(inputs).not.toContain("worker/src/ingress/meta.ts");
    expect(inputs).not.toContain("worker/src/egress/fetch.ts");
    expect(inputs).not.toContain("worker/src/response/payload-stream.ts");
    expect(code).toContain("/wss");
    expect(code).toContain("cf-socks auth v2");
    expect(code).not.toContain("/direct/");
    expect(code).not.toContain("/direct-url");
    expect(code).not.toContain("/__meta");
    expect(code).not.toContain("DIRECT_BEARER");
  });

  it("builds direct-connect without encrypted bearer or wss modules", () => {
    const { inputs, code } = buildProfile("direct-connect");
    expect(inputs).toContain("worker/src/profiles/direct-connect.ts");
    expect(inputs).toContain("worker/src/auth/static-bearer.ts");
    expect(inputs).toContain("worker/src/ingress/direct-path.ts");
    expect(inputs).toContain("worker/src/response/payload-stream.ts");
    expect(inputs).toContain("worker/src/egress/connect.ts");
    expect(inputs).not.toContain("worker/src/ingress/target-url.ts");
    expect(inputs).not.toContain("worker/src/egress/fetch.ts");
    expect(inputs).not.toContain("worker/src/auth/bearer-claims.ts");
    expect(inputs).not.toContain("worker/src/token.ts");
    expect(inputs).not.toContain("worker/src/response/wss-tunnel.ts");
    expect(code).toContain("/direct/");
    expect(code).toContain("DIRECT_BEARER");
    expect(code).not.toContain('pathname === "/direct-url"');
    expect(code).not.toContain("targetRequestHeaders");
    expect(code).not.toContain("cf-socks auth v2");
    expect(code).not.toContain("ERR connect_failed");
    expect(code).not.toContain("/wss");
    expect(code).not.toContain("/h2");
    expect(code).not.toContain("/h3");
    expect(code).not.toContain("/__meta");
  });

  it("builds url-full with URL ingress plus connect and fetch egress only", () => {
    const { inputs, code } = buildProfile("url-full");
    expect(inputs).toContain("worker/src/profiles/url-full.ts");
    expect(inputs).toContain("worker/src/auth/static-bearer.ts");
    expect(inputs).toContain("worker/src/ingress/target-url.ts");
    expect(inputs).toContain("worker/src/egress/connect.ts");
    expect(inputs).toContain("worker/src/egress/fetch.ts");
    expect(inputs).toContain("worker/src/response/payload-stream.ts");
    expect(inputs).not.toContain("worker/src/auth/bearer-claims.ts");
    expect(inputs).not.toContain("worker/src/token.ts");
    expect(inputs).not.toContain("worker/src/ingress/direct-path.ts");
    expect(inputs).not.toContain("worker/src/ingress/meta.ts");
    expect(inputs).not.toContain("worker/src/response/wss-tunnel.ts");
    expect(code).toContain("/direct-url");
    expect(code).toContain("DIRECT_BEARER");
    expect(code).toContain("fetch(");
    expect(code).not.toContain("cf-socks auth v2");
    expect(code).not.toContain("ERR connect_failed");
    expect(code).not.toContain('startsWith("/direct/")');
    expect(code).not.toContain("/wss");
    expect(code).not.toContain("/h2");
    expect(code).not.toContain("/h3");
    expect(code).not.toContain("/__meta");
  });
});

function buildProfile(profile: string): { inputs: string[]; code: string } {
  const outfile = `${bundleDir}/${profile}.js`;
  const metafile = `${bundleDir}/${profile}.json`;
  execFileSync("node", ["worker/build.mjs", "--profile", profile, "--outfile", outfile, "--metafile", metafile], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  const meta = JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> };
  return {
    inputs: Object.keys(meta.inputs).sort(),
    code: readFileSync(outfile, "utf8"),
  };
}
