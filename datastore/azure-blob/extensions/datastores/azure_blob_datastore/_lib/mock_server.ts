// ABOUTME: Hand-rolled mock Azure Blob Storage REST server for tests — covers
// ABOUTME: PUT/GET blob with conditional headers, ?comp=lease, ?comp=metadata,
// ABOUTME: and ?comp=list — no signature verification (auth is tested separately).

interface MockBlob {
  content: Uint8Array;
  etag: string;
  leaseState: "available" | "leased";
  leaseId?: string;
  metadata: Record<string, string>;
}

export interface MockAzureServer {
  server: Deno.HttpServer;
  port: number;
  blobs: Map<string, MockBlob>;
}

let etagCounter = 0;
function nextEtag(): string {
  etagCounter++;
  return `"0x${etagCounter.toString(16).padStart(16, "0")}"`;
}

export function createMockAzureServer(): MockAzureServer {
  const blobs = new Map<string, MockBlob>();

  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    // pathname is /container/blob/path...
    const blobKey = decodeURIComponent(url.pathname);
    const comp = url.searchParams.get("comp");
    const restype = url.searchParams.get("restype");

    if (restype === "container" && comp === "list") {
      const listPrefix = url.searchParams.get("prefix") ?? "";
      const containerPrefix = blobKey.replace(/\/$/, "") + "/";
      const names = [...blobs.keys()]
        .filter((k) => k.startsWith(containerPrefix))
        .map((k) => k.slice(containerPrefix.length))
        .filter((name) => name.startsWith(listPrefix));
      const xmlBlobs = names.map((name) => `<Blob><Name>${name}</Name></Blob>`)
        .join("");
      const xml =
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${xmlBlobs}</Blobs><NextMarker/></EnumerationResults>`;
      return new Response(xml, { status: 200 });
    }

    if (restype === "container" && !comp) {
      return new Response(null, { status: 200 });
    }

    if (comp === "lease") {
      const action = req.headers.get("x-ms-lease-action");
      const leaseIdHeader = req.headers.get("x-ms-lease-id");
      const blob = blobs.get(blobKey);
      if (!blob) return new Response(null, { status: 404 });

      if (action === "acquire") {
        if (blob.leaseState === "leased") {
          return new Response("LeaseAlreadyPresent", { status: 409 });
        }
        const leaseId = crypto.randomUUID();
        blob.leaseState = "leased";
        blob.leaseId = leaseId;
        return new Response(null, {
          status: 201,
          headers: { "x-ms-lease-id": leaseId },
        });
      }
      if (action === "renew") {
        if (blob.leaseState !== "leased" || blob.leaseId !== leaseIdHeader) {
          return new Response("LeaseIdMismatchWithLeaseOperation", {
            status: 412,
          });
        }
        return new Response(null, { status: 200 });
      }
      if (action === "release") {
        if (blob.leaseState !== "leased" || blob.leaseId !== leaseIdHeader) {
          return new Response("LeaseIdMismatchWithLeaseOperation", {
            status: 412,
          });
        }
        blob.leaseState = "available";
        blob.leaseId = undefined;
        return new Response(null, { status: 200 });
      }
      return new Response("UnsupportedLeaseAction", { status: 400 });
    }

    if (comp === "metadata" && req.method === "PUT") {
      const blob = blobs.get(blobKey);
      if (!blob) return new Response(null, { status: 404 });
      const leaseIdHeader = req.headers.get("x-ms-lease-id");
      if (blob.leaseState === "leased" && blob.leaseId !== leaseIdHeader) {
        return new Response("LeaseIdMismatchWithBlobOperation", {
          status: 412,
        });
      }
      const metadata: Record<string, string> = {};
      for (const [name, value] of req.headers.entries()) {
        if (name.toLowerCase().startsWith("x-ms-meta-")) {
          metadata[name.slice("x-ms-meta-".length)] = value;
        }
      }
      blob.metadata = metadata;
      return new Response(null, { status: 200 });
    }

    if (comp === "metadata" && req.method === "GET") {
      const blob = blobs.get(blobKey);
      if (!blob) return new Response(null, { status: 404 });
      const headers = new Headers();
      headers.set("x-ms-lease-state", blob.leaseState);
      for (const [k, v] of Object.entries(blob.metadata)) {
        headers.set(`x-ms-meta-${k}`, v);
      }
      return new Response(null, { status: 200, headers });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const blob = blobs.get(blobKey);
      if (!blob) return new Response(null, { status: 404 });
      const headers = new Headers();
      headers.set("etag", blob.etag);
      const body = req.method === "GET"
        ? (new Uint8Array(blob.content).buffer as ArrayBuffer)
        : null;
      return new Response(body, { status: 200, headers });
    }

    return new Response(null, { status: 404 });
  };

  const asyncHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const comp = url.searchParams.get("comp");
    const restype = url.searchParams.get("restype");
    if (req.method === "PUT" && !comp && !restype) {
      const blobKey = decodeURIComponent(url.pathname);
      const existing = blobs.get(blobKey);
      const ifMatch = req.headers.get("if-match");
      const ifNoneMatch = req.headers.get("if-none-match");
      if (ifNoneMatch === "*" && existing) {
        return new Response("BlobAlreadyExists", { status: 412 });
      }
      if (ifMatch && (!existing || existing.etag !== ifMatch)) {
        return new Response("ConditionNotMet", { status: 412 });
      }
      const content = new Uint8Array(await req.arrayBuffer());
      const etag = nextEtag();
      blobs.set(blobKey, {
        content,
        etag,
        leaseState: existing?.leaseState ?? "available",
        leaseId: existing?.leaseId,
        metadata: existing?.metadata ?? {},
      });
      return new Response(null, { status: 201, headers: { etag } });
    }
    return handler(req);
  };

  const server = Deno.serve({ port: 0, onListen() {} }, asyncHandler);
  const addr = server.addr as Deno.NetAddr;
  return { server, port: addr.port, blobs };
}
