/**
 * Guards the release metadata. The publish workflow derives every version from
 * the git tag and writes the result back into package.json and server.json, so
 * these files are only ever wrong when something in that pipeline drifted —
 * which is exactly the failure that would otherwise reach the MCP Registry.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (name: string) => JSON.parse(readFileSync(resolve(root, name), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");

const IMAGE = "ghcr.io/ohneben/wafeq-mcp";

describe("release metadata", () => {
  it("keeps server.json on the same version as package.json", () => {
    expect(server.version).toBe(pkg.version);
  });

  it("pins the registry package to that version's image", () => {
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].registryType).toBe("oci");
    expect(server.packages[0].identifier).toBe(`${IMAGE}:${pkg.version}`);
  });

  it("carries the registry ownership label on the image", () => {
    // Without a label matching server.json's name, the MCP Registry refuses the
    // OCI package as unproven.
    expect(dockerfile).toContain(`LABEL io.modelcontextprotocol.server.name="${server.name}"`);
  });

  it("keeps the description inside the registry's 100-character limit", () => {
    // The MCP Registry rejects a longer description with an HTTP 422, and it does
    // so at publish time — after the image is already pushed. This is the cheap
    // local version of that check.
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("declares the transport switch the registry entry tells clients to set", () => {
    const names = server.packages[0].environmentVariables.map((v: { name: string }) => v.name);
    expect(names).toContain("MCP_TRANSPORT");
    expect(names).toContain("WAFEQ_API_KEY");
  });

  it("reports the package.json version over MCP", async () => {
    // The server reads its version at runtime rather than hard-coding one, so a
    // stamped release number reaches /health and initialize without a code edit.
    const source = readFileSync(resolve(root, "src", "index.ts"), "utf8");
    expect(source).toContain("readPackageVersion()");
    expect(source).not.toMatch(/const SERVER_VERSION = "\d/);
  });
});
