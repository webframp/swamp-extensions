import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { buildStringToSign, parseConnectionString } from "./rest_client.ts";

// Known-good vector adapted from Microsoft's published Shared Key signing
// example (Azure Storage REST API — "Authorize with Shared Key"):
//   GET https://myaccount.blob.core.windows.net/mycontainer/myblob
//   x-ms-date: Wed, 23 Sep 2009 20:51:47 GMT
//   x-ms-version: 2009-09-19
Deno.test("buildStringToSign matches Microsoft's published Shared Key example", () => {
  const headers = new Headers({
    "x-ms-date": "Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-version": "2009-09-19",
  });
  const stringToSign = buildStringToSign(
    "myaccount",
    "GET",
    "/mycontainer/myblob",
    headers,
    0,
  );
  const expected = "GET\n\n\n\n\n\n\n\n\n\n\n\n" +
    "x-ms-date:Wed, 23 Sep 2009 20:51:47 GMT\n" +
    "x-ms-version:2009-09-19\n" +
    "/myaccount/mycontainer/myblob";
  assertEquals(stringToSign, expected);
});

Deno.test("buildStringToSign sorts x-ms- headers lexicographically", () => {
  const headers = new Headers({
    "x-ms-version": "2021-08-06",
    "x-ms-date": "Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-lease-id": "abc-123",
  });
  const stringToSign = buildStringToSign(
    "myaccount",
    "PUT",
    "/mycontainer/myblob",
    headers,
    0,
  );
  const headerLines = stringToSign.split("\n").filter((l) =>
    l.startsWith("x-ms-")
  );
  assertEquals(headerLines, [
    "x-ms-date:Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-lease-id:abc-123",
    "x-ms-version:2021-08-06",
  ]);
});

Deno.test("buildStringToSign includes non-zero content-length", () => {
  const headers = new Headers({ "x-ms-date": "d", "x-ms-version": "v" });
  const stringToSign = buildStringToSign(
    "myaccount",
    "PUT",
    "/mycontainer/myblob",
    headers,
    42,
  );
  const contentLengthField = stringToSign.split("\n")[3];
  assertEquals(contentLengthField, "42");
});

Deno.test("buildStringToSign sorts and comma-joins repeated query params", () => {
  const headers = new Headers({ "x-ms-date": "d", "x-ms-version": "v" });
  const stringToSign = buildStringToSign(
    "myaccount",
    "GET",
    "/mycontainer/myblob?comp=metadata&timeout=30",
    headers,
    0,
  );
  const resourceLines = stringToSign.split("\n").slice(-3);
  assertEquals(resourceLines, [
    "/myaccount/mycontainer/myblob",
    "comp:metadata",
    "timeout:30",
  ]);
});

Deno.test("parseConnectionString extracts account name/key/endpoint suffix", () => {
  const parsed = parseConnectionString(
    "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=c3VwZXJzZWNyZXQ=;EndpointSuffix=core.windows.net",
  );
  assertEquals(parsed.accountName, "myaccount");
  assertEquals(parsed.accountKey, "c3VwZXJzZWNyZXQ=");
  assertEquals(parsed.endpointSuffix, "core.windows.net");
});

Deno.test("parseConnectionString defaults endpointSuffix when absent", () => {
  const parsed = parseConnectionString(
    "AccountName=myaccount;AccountKey=c3VwZXJzZWNyZXQ=",
  );
  assertEquals(parsed.endpointSuffix, "core.windows.net");
});

Deno.test("parseConnectionString throws when AccountKey is missing", () => {
  assertThrows(
    () => parseConnectionString("AccountName=myaccount"),
    Error,
    "AccountName and AccountKey",
  );
});
