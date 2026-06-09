import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./mod.ts";

// =============================================================================
// Test helpers
// =============================================================================

function createMockContext(stored: Record<string, unknown> | null = null) {
  const written: Array<{ spec: string; name: string; data: Record<string, unknown> }> = [];
  return {
    ctx: {
      globalArgs: {
        likelihoodScale: "test scale",
        impactScale: "test scale",
        mitigationFramework: "CWE",
      },
      logger: { info: (_msg: string, _meta?: Record<string, unknown>) => {} },
      writeResource: async (spec: string, name: string, data: Record<string, unknown>) => {
        written.push({ spec, name, data });
        return { name, specName: spec, kind: "resource", dataId: "test", version: 1, size: 0 };
      },
      readResource: async (_name: string) => stored,
    },
    written,
  };
}

// =============================================================================
// scope
// =============================================================================

Deno.test("scope creates assessment resource", async () => {
  const { ctx, written } = createMockContext();
  await model.methods.scope.execute(
    { subject: "Test system", scope: "Full system", currentPosture: "No controls", assets: [] },
    ctx,
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "assessment");
  assertEquals(written[0].data.subject, "Test system");
  assertEquals(written[0].data.threats, []);
});

// =============================================================================
// identify
// =============================================================================

Deno.test("identify adds threats with computed risk", async () => {
  const { ctx, written } = createMockContext({
    subject: "Test", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [], controls: [], acceptances: [], recommendation: "", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.identify.execute(
    {
      threats: [{
        id: "T1", title: "Test threat", description: "desc",
        likelihood: "certain", impact: "high",
        exploitation: "exploit", mitigatingFactors: "none",
      }],
    },
    ctx,
  );
  const threats = written[0].data.threats as Array<Record<string, unknown>>;
  assertEquals(threats.length, 1);
  assertEquals(threats[0].inherentRisk, "high");
  assertEquals(threats[0].status, "unaddressed");
});

Deno.test("identify throws without prior scope", async () => {
  const { ctx } = createMockContext(null);
  await assertRejects(
    () => model.methods.identify.execute({ threats: [{ id: "T1", title: "t", description: "d", likelihood: "certain", impact: "low", exploitation: "e", mitigatingFactors: "m" }] }, ctx),
    Error,
    "No assessment",
  );
});

Deno.test("risk matrix: possible × low = negligible", async () => {
  const { ctx, written } = createMockContext({
    subject: "T", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [], controls: [], acceptances: [], recommendation: "", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.identify.execute(
    { threats: [{ id: "T1", title: "t", description: "d", likelihood: "possible", impact: "low", exploitation: "e", mitigatingFactors: "m" }] },
    ctx,
  );
  const threats = written[0].data.threats as Array<Record<string, unknown>>;
  assertEquals(threats[0].inherentRisk, "negligible");
});

// =============================================================================
// evaluate
// =============================================================================

Deno.test("evaluate records open questions and adjusts scores", async () => {
  const { ctx, written } = createMockContext({
    subject: "T", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [{ id: "T1", title: "t", description: "d", likelihood: "certain", impact: "high", inherentRisk: "high", exploitation: "e", mitigatingFactors: "m", status: "unaddressed" }],
    controls: [], acceptances: [], recommendation: "", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.evaluate.execute(
    { openQuestions: ["Q1"], adjustments: [{ threatId: "T1", likelihood: "unlikely" }] },
    ctx,
  );
  assertEquals(written[0].data.openQuestions, ["Q1"]);
  const threats = written[0].data.threats as Array<Record<string, unknown>>;
  assertEquals(threats[0].likelihood, "unlikely");
  assertEquals(threats[0].inherentRisk, "low");
});

// =============================================================================
// mitigate
// =============================================================================

Deno.test("mitigate updates threat statuses", async () => {
  const { ctx, written } = createMockContext({
    subject: "T", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [
      { id: "T1", title: "t1", description: "d", likelihood: "certain", impact: "high", inherentRisk: "high", exploitation: "e", mitigatingFactors: "m", status: "unaddressed" },
      { id: "T2", title: "t2", description: "d", likelihood: "possible", impact: "low", inherentRisk: "negligible", exploitation: "e", mitigatingFactors: "m", status: "unaddressed" },
    ],
    controls: [], acceptances: [], recommendation: "", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.mitigate.execute(
    {
      controls: [{ id: "C1", description: "ctrl", mitigates: ["T1"], effectiveness: "full", implemented: true }],
      acceptances: [{ threatId: "T2", rationale: "low risk", acceptedBy: "webframp" }],
      deferred: [],
      recommendation: "Proceed",
    },
    ctx,
  );
  const threats = written[0].data.threats as Array<Record<string, unknown>>;
  assertEquals(threats[0].status, "mitigated");
  assertEquals(threats[1].status, "accepted");
});

// =============================================================================
// posture
// =============================================================================

Deno.test("posture computes summary correctly", async () => {
  const { ctx, written } = createMockContext({
    subject: "T", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [
      { id: "T1", title: "t1", description: "d", likelihood: "certain", impact: "high", inherentRisk: "high", exploitation: "e", mitigatingFactors: "m", status: "mitigated" },
      { id: "T2", title: "t2", description: "d", likelihood: "possible", impact: "low", inherentRisk: "negligible", exploitation: "e", mitigatingFactors: "m", status: "accepted" },
    ],
    controls: [{ id: "C1", description: "ctrl", mitigates: ["T1"], effectiveness: "full", implemented: true }],
    acceptances: [], recommendation: "Proceed", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.posture.execute({}, ctx);
  const posture = written[0].data;
  assertEquals(posture.totalThreats, 2);
  assertEquals((posture.byStatus as Record<string, number>).mitigated, 1);
  assertEquals((posture.byStatus as Record<string, number>).accepted, 1);
  assertEquals(posture.overallPosture, "acceptable");
  assertEquals((posture.controlsCoverage as Record<string, number>).implemented, 1);
});

Deno.test("posture is unacceptable with unaddressed high threats", async () => {
  const { ctx, written } = createMockContext({
    subject: "T", scope: "s", currentPosture: "p", assessedAt: "2026-01-01",
    assets: [], threats: [
      { id: "T1", title: "critical unaddressed", description: "d", likelihood: "certain", impact: "critical", inherentRisk: "critical", exploitation: "e", mitigatingFactors: "m", status: "unaddressed" },
    ],
    controls: [], acceptances: [], recommendation: "", openQuestions: [], updatedAt: "2026-01-01",
  });
  await model.methods.posture.execute({}, ctx);
  assertEquals(written[0].data.overallPosture, "unacceptable");
});
