import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  generateApiLib,
  generateApiLibTest,
  generateDenoJson,
  generateGitignore,
  generateLicense,
  generateManifest,
  generateReadme,
  generateReleaseNotes,
  generateSwampYaml,
  modelRequiresVault,
} from "./extension_generator.ts";
import { classifyServiceMethods } from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import { MAX_PAGES, PAGE_SIZE, SERVICES } from "../config.ts";
import { MAX_PAGES as RUNTIME_MAX_PAGES } from "./runtime/api.ts";
import { loadSpec } from "./spec_fixture.ts";

const groups = groupOperations(loadSpec(), SERVICES);
const group = (name: string) => groups.find((g) => g.config.name === name)!;

Deno.test("generateManifest: names the extension, declares Apache-2.0 and ships LICENSE.md", () => {
  const manifest = generateManifest(
    group("secondary-dns").config,
    "2026.11.02.1",
    "secondary_dns.ts",
  );
  assertStringIncludes(manifest, 'name: "@webframp/dnsimple/secondary-dns"');
  assertMatch(manifest, /^license: Apache-2\.0$/m);
  assertStringIncludes(manifest, "  - dnsimple/secondary_dns.ts");
  assertStringIncludes(manifest, "  - LICENSE.md");
  // RELEASE_NOTES.md is consumed by CI only and must not ship.
  assertEquals(manifest.includes("RELEASE_NOTES.md"), false);
});

Deno.test("generateDenoJson: pins swamp-testing and carries no dependency import map entry for zod", () => {
  const json = JSON.parse(generateDenoJson());
  assertEquals(Object.keys(json.imports), ["@swamp-club/swamp-testing"]);
  assertEquals(json.lint.rules.exclude, ["no-import-prefix"]);
  assertEquals(typeof json.tasks["fmt:check"], "string");
  assertEquals(json.tasks.fmt.includes("--check"), false);
});

Deno.test("generateReadme: shows the vault path end to end and never a literal token", () => {
  const readme = generateReadme(
    group("zones").config,
    classifyServiceMethods(group("zones")),
  );
  assertStringIncludes(readme, "swamp vault create local_encryption dnsimple");
  assertStringIncludes(readme, "swamp vault put dnsimple API_TOKEN");
  assertStringIncludes(
    readme,
    `'apiToken=\${{ vault.get("dnsimple", "API_TOKEN") }}'`,
  );
  assertStringIncludes(
    readme,
    "--global-arg accountId=<account id from whoami>",
  );
  assertStringIncludes(readme, "environment=sandbox");
  // The environment variable is named only as a discouraged fallback.
  assertStringIncludes(readme, "is not redacted from swamp output and is not");
  assertEquals(/vault:\/\/|swamp vault set|glpat-|<vault:/.test(readme), false);
});

Deno.test("generateReadme: lists the billable methods", () => {
  const readme = generateReadme(
    group("registrar").config,
    classifyServiceMethods(group("registrar")),
  );
  assertStringIncludes(readme, "## Billable methods");
  for (
    const m of [
      "register_domain",
      "renew_domain",
      "transfer_domain",
      "restore_domain",
    ]
  ) {
    assertStringIncludes(readme, `- \`${m}\``);
  }
  assertEquals(
    generateReadme(group("tlds").config, classifyServiceMethods(group("tlds")))
      .includes("Billable methods"),
    false,
  );
});

Deno.test("generateReadme: documents a returned secret and the vault swamp then requires", () => {
  const methods = classifyServiceMethods(group("certificates"));
  assertEquals(modelRequiresVault(methods), true);
  const readme = generateReadme(group("certificates").config, methods);
  assertStringIncludes(readme, "## Secrets");
  assertStringIncludes(
    readme,
    "| `get_certificate_private_key` | `private_key` |",
  );
  assertStringIncludes(readme, "until a vault exists");
  assertEquals(
    modelRequiresVault(classifyServiceMethods(group("zones"))),
    false,
  );
});

Deno.test("generateReadme: documents a secret argument", () => {
  const readme = generateReadme(
    group("registrar").config,
    classifyServiceMethods(group("registrar")),
  );
  assertStringIncludes(readme, "| `transfer_domain` | `auth_code` |");
  // registrar returns no secret, so it needs no vault.
  assertEquals(readme.includes("until a vault exists"), false);
});

Deno.test("generateReadme: escapes pipes in method descriptions", () => {
  const readme = generateReadme(group("tlds").config, [
    { name: "x", description: "a | b", type: "get" },
  ]);
  assertStringIncludes(readme, "| `x` | a \\| b |");
});

Deno.test("generateReleaseNotes: an initial release, or the supplied notes", () => {
  const config = group("secondary-dns").config;
  assertStringIncludes(
    generateReleaseNotes(config, "2026.11.02.1", 7),
    "Initial code-generated release of @webframp/dnsimple/secondary-dns with 7 methods",
  );
  assertEquals(
    generateReleaseNotes(config, "2026.11.02.2", 7, "**Fixed:** x\n"),
    "## 2026.11.02.2\n\n**Fixed:** x\n",
  );
});

Deno.test("generateSwampYaml: carries an existing repoId forward", () => {
  assertEquals(generateSwampYaml().includes("repoId"), false);
  assertStringIncludes(
    generateSwampYaml("repoVersion: 1\nrepoId: abc-123\n"),
    "repoId: abc-123",
  );
});

Deno.test("generateGitignore and generateLicense: the repository conventions", () => {
  assertEquals(generateGitignore(), ".swamp/\nCLAUDE.md\nAGENTS.md\n");
  const license = generateLicense();
  assertStringIncludes(license, "Apache License");
  assertEquals(
    license.match(/^Copyright .*/gm),
    ["Copyright 2026 Sean Escriva"],
  );
});

Deno.test("generateApiLib: ships the runtime helper verbatim", () => {
  const lib = generateApiLib();
  assertEquals(
    lib,
    Deno.readTextFileSync(new URL("./runtime/api.ts", import.meta.url)),
  );
  assertStringIncludes(lib, 'sandbox: "https://api.sandbox.dnsimple.com/v2"');
  assertStringIncludes(
    generateApiLibTest(),
    'from "./api.ts"',
  );
});

Deno.test("pagination bounds: one definition, re-exported by config", () => {
  assertEquals(MAX_PAGES, RUNTIME_MAX_PAGES);
  assertEquals(MAX_PAGES, 20);
  assertEquals(PAGE_SIZE, 100);
});

Deno.test("generateApiLib: carries no secret-shaped literal and no reserved-name literal", () => {
  const lib = generateApiLib();
  assertEquals(/glpat-|sk-ant-|hvs\.|eyJ/.test(lib), false);
  assertEquals(/["'`]latest["'`]/.test(lib), false);
});
