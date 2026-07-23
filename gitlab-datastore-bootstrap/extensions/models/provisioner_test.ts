import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./provisioner.ts";

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => { status: number; body: string };

function withMockedFetch<T>(
  handler: FetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const result = handler(url, init);
    return Promise.resolve(
      new Response(result.body, {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function createMockContext(globalArgs: {
  project_id: string;
  base_url: string;
  token: string;
  username?: string;
  state_prefix: string;
  create_project_token: boolean;
  project_token_name: string;
}) {
  const written: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    context: {
      globalArgs,
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
    written,
  };
}

const BASE_ARGS = {
  project_id: "12345",
  base_url: "https://gitlab.example.com",
  token: "glpat-test-token",
  state_prefix: "swamp",
  create_project_token: false,
  project_token_name: "swamp-datastore",
};

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/gitlab-datastore-bootstrap/provisioner");
  assertEquals(model.version, "2026.07.22.1");
});

Deno.test("model has provision method", () => {
  assertEquals(typeof model.methods.provision.execute, "function");
});

Deno.test("globalArguments defaults are correct", () => {
  const parsed = model.globalArguments.parse({
    project_id: "123",
    token: "glpat-xxx",
  });
  assertEquals(parsed.base_url, "https://gitlab.com");
  assertEquals(parsed.state_prefix, "swamp");
  assertEquals(parsed.create_project_token, false);
  assertEquals(parsed.project_token_name, "swamp-datastore");
});

Deno.test("globalArguments requires project_id and token", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("provision validates project and produces config", async () => {
  const { context, written } = createMockContext(BASE_ARGS);

  const handler: FetchHandler = (url) => {
    if (url.includes("/projects/12345") && !url.includes("terraform")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 12345,
          name: "my-project",
          web_url: "https://gitlab.example.com/group/my-project",
        }),
      };
    }
    if (url.includes("terraform/state/swamp-healthcheck")) {
      return { status: 404, body: "{}" };
    }
    return { status: 200, body: "{}" };
  };

  await withMockedFetch(handler, async () => {
    const result = await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0]!.data.projectId, "12345");
    assertEquals(written[0]!.data.projectName, "my-project");
    assertEquals(written[0]!.data.tokenType, "provided");
    assertEquals(written[0]!.data.projectTokenCreated, false);

    const config = JSON.parse(written[0]!.data.datastoreConfig as string);
    assertEquals(config.projectId, "12345");
    assertEquals(config.baseUrl, "https://gitlab.example.com");
    assertEquals(config.token, "glpat-test-token");
    assertEquals(config.statePrefix, "swamp");
  });
});

Deno.test("provision creates project token when requested", async () => {
  const { context, written } = createMockContext({
    ...BASE_ARGS,
    create_project_token: true,
  });

  const handler: FetchHandler = (url, init) => {
    if (
      url.includes("/projects/12345") && !url.includes("terraform") &&
      !url.includes("access_tokens")
    ) {
      return {
        status: 200,
        body: JSON.stringify({
          name: "my-project",
          web_url: "https://gitlab.example.com/group/my-project",
        }),
      };
    }
    if (url.includes("terraform/state/")) {
      return { status: 404, body: "{}" };
    }
    if (url.includes("access_tokens") && init?.method === "POST") {
      return {
        status: 201,
        body: JSON.stringify({
          id: 99,
          token: "glpat-new-project-token",
          name: "swamp-datastore",
        }),
      };
    }
    return { status: 200, body: "{}" };
  };

  await withMockedFetch(handler, async () => {
    await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(written[0]!.data.tokenType, "project_access_token");
    assertEquals(written[0]!.data.projectTokenCreated, true);

    const config = JSON.parse(written[0]!.data.datastoreConfig as string);
    assertEquals(config.token, "glpat-new-project-token");
  });
});

Deno.test("provision throws on invalid token", async () => {
  const { context } = createMockContext(BASE_ARGS);

  const handler: FetchHandler = () => {
    return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
  };

  await withMockedFetch(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "invalid or expired",
    );
  });
});

Deno.test("provision throws on project not found", async () => {
  const { context } = createMockContext(BASE_ARGS);

  const handler: FetchHandler = () => {
    return { status: 404, body: "{}" };
  };

  await withMockedFetch(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "not found",
    );
  });
});

Deno.test("provision throws when state API returns 403", async () => {
  const { context } = createMockContext(BASE_ARGS);

  const handler: FetchHandler = (url) => {
    if (url.includes("/projects/12345") && !url.includes("terraform")) {
      return {
        status: 200,
        body: JSON.stringify({ name: "proj", web_url: "https://x" }),
      };
    }
    if (url.includes("terraform/state/")) {
      return { status: 403, body: "{}" };
    }
    return { status: 200, body: "{}" };
  };

  await withMockedFetch(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "lacks access to Terraform state API",
    );
  });
});

Deno.test("provision includes username in config when provided", async () => {
  const { context, written } = createMockContext({
    ...BASE_ARGS,
    username: "myuser",
  });

  const handler: FetchHandler = (url) => {
    if (url.includes("/projects/") && !url.includes("terraform")) {
      return {
        status: 200,
        body: JSON.stringify({ name: "p", web_url: "https://x" }),
      };
    }
    return { status: 404, body: "{}" };
  };

  await withMockedFetch(handler, async () => {
    await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    const config = JSON.parse(written[0]!.data.datastoreConfig as string);
    assertEquals(config.username, "myuser");
  });
});
