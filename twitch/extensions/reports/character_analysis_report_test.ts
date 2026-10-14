import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./character_analysis_report.ts";

Deno.test("character analysis report has workflow scope", () => {
  assertEquals(report.name, "@webframp/twitch-character-analysis-report");
  assertEquals(report.scope, "workflow");
});

Deno.test({
  name: "character analysis report degrades when workflow data is unavailable",
  fn: async () => {
    const result = await report.execute({
      workflowName: "@webframp/twitch-character-analysis",
      workflowStatus: "failed",
      stepExecutions: [],
      repoDir: "/tmp/does-not-exist",
      logger: { info: () => {} },
    });

    assertStringIncludes(result.markdown, "@unknown");
    assertStringIncludes(result.markdown, "unavailable");
    assertEquals(result.json.username, "unknown");
  },
});
