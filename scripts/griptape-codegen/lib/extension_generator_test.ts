/**
 * Tests for the extension generator module.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateReadme, generateReleaseNotes } from "./extension_generator.ts";
import type { GroupedOperation } from "./service_grouper.ts";

// ---------------------------------------------------------------------------
// generateReleaseNotes
//
// RELEASE_NOTES.md describes only the version being published: CI passes it
// to the registry and the GitHub release for that version. Earlier notes live
// in git history, so a regeneration overwrites the file.
// ---------------------------------------------------------------------------

const cfg = {
  name: "threads",
  description: "Griptape Cloud Threads",
  pathPrefixes: ["/api/threads"],
  labels: ["griptape"],
};

Deno.test("generateReleaseNotes: defaults to initial-release text", () => {
  const notes = generateReleaseNotes(cfg, "2026.08.29.1", 7);
  assertEquals(notes.startsWith("## 2026.08.29.1"), true);
  assertEquals(notes.includes("Initial code-generated release"), true);
  assertEquals(notes.includes("7 methods"), true);
});

Deno.test("generateReleaseNotes: holds exactly one section, for the new version", () => {
  const notes = generateReleaseNotes(
    cfg,
    "2026.09.17.1",
    7,
    "Regenerated from updated API spec.\n\n",
  );
  assertEquals(
    notes,
    "## 2026.09.17.1\n\nRegenerated from updated API spec.\n",
  );
  assertEquals(notes.match(/^## /gm)?.length, 1);
});

// ---------------------------------------------------------------------------
// generateReadme
// ---------------------------------------------------------------------------

function op(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/api/x",
    operationId: "GetX",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

Deno.test("generateReadme: leads with the vault and never shows a literal key", () => {
  const readme = generateReadme(cfg, [
    { name: "list_threads", description: "list operation", type: "list" },
  ]);
  assertStringIncludes(readme, "## Credentials");
  assertStringIncludes(readme, "swamp vault put griptape API_KEY");
  assertStringIncludes(
    readme,
    `--global-arg 'apiKey=\${{ vault.get("griptape", "API_KEY") }}'`,
  );
  assertStringIncludes(readme, "not redacted and is not recommended");
  assert(!readme.includes("GRIPTAPE_CLOUD_API_KEY"));
  assert(!readme.includes("overrides the `GT_CLOUD_API_KEY`"));
  // No secret-handling sections when nothing in the service carries one.
  assert(!readme.includes("## Secrets"));
  assert(!readme.includes("Secret-valued arguments"));
  assert(!readme.includes("Credentials in responses"));
  assert(!readme.includes("refuses to run"));
});

Deno.test("generateReadme: tells users to pass secret-valued arguments via vault.get", () => {
  const secrets = { ...cfg, name: "secrets" };
  const readme = generateReadme(secrets, [{
    name: "create_secret",
    description: "create operation",
    type: "create",
    operation: op({
      httpMethod: "post",
      operationId: "CreateSecret",
      requestBody: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
      },
    }),
  }]);
  assertStringIncludes(readme, "## Secrets");
  assertStringIncludes(readme, "### Secret-valued arguments");
  // Secret arguments alone declare no sensitive resource field.
  assert(!readme.includes("refuses to run"));
  assertStringIncludes(readme, "- `create_secret`: `value`");
  assertStringIncludes(readme, "recorded in cleartext");
  assertStringIncludes(
    readme,
    `swamp model method run gt-secrets create_secret \\
  --input 'value=\${{ vault.get("griptape", "<KEY>") }}'`,
  );
});

Deno.test("generateReadme: explains vaulted and dropped response credentials", () => {
  const tree = { config: { google_drive: { access_token: true as const } } };
  const readme = generateReadme({ ...cfg, name: "data-connectors" }, [
    {
      name: "list_data_connectors",
      description: "list operation",
      type: "list",
      operation: op({
        operationId: "ListDataConnectors",
        sensitiveResponse: tree,
      }),
    },
    {
      name: "get_data_connector",
      description: "get operation",
      type: "get",
      operation: op({
        operationId: "GetDataConnector",
        sensitiveResponse: tree,
        sensitiveBodyFields: undefined,
      }),
    },
    {
      name: "create_data_connector",
      description: "create operation",
      type: "create",
      operation: op({
        httpMethod: "post",
        operationId: "CreateDataConnector",
        requestBody: { type: "object", properties: { config: {} } },
        sensitiveBodyFields: ["config"],
      }),
    },
  ]);
  assertStringIncludes(readme, "## Secrets");
  assertStringIncludes(readme, "### Credentials in responses");
  // The resource's sensitive field makes swamp demand a vault for every
  // method, get_data_connector included: swamp infers its kind from the
  // exact name only. Stated under Credentials and Secrets.
  const flat = readme.replace(/\s+/g, " ");
  const sentence =
    "swamp refuses to run any of its methods, reads included, until a vault exists";
  assertEquals(flat.split(sentence).length - 1, 2);
  assert(!readme.includes("fail unless a vault exists"));
  assertStringIncludes(
    readme,
    "The `data_connector` resource marks `config.google_drive.access_token` as sensitive",
  );
  assertStringIncludes(
    readme,
    "`list_data_connectors` drops `config.google_drive.access_token`",
  );
  // An object argument gets the nested-field note, not a string example.
  assertStringIncludes(
    readme,
    "`config` is an object that holds the credential in one of its fields",
  );
  assert(!readme.includes("--input 'config="));
});
