# @webframp/network

DNS and network probing model for swamp. Provides diagnostic methods that wrap
standard network utilities -- dig, whois, openssl, ping, and traceroute -- and
produce structured, typed resources you can query, report on, and compose into
workflows.

## Prerequisites

- swamp CLI version `20260505` or later. Run `swamp update` to get the latest
  version.

The following command-line utilities must be available on the host:

- `dig` -- DNS lookups, used by `dns_lookup` (usually provided by `bind-utils`
  or `dnsutils`)
- `whois` -- domain registration queries, used by `whois_lookup`
- `openssl` -- TLS certificate inspection, used by `cert_check`
- `traceroute` -- network path tracing, used by `traceroute`

No cloud credentials or API keys are required.

## Installation

```bash
swamp extension pull @webframp/network
```

## Usage

### Create the model

```bash
swamp model create @webframp/network net-probe
```

### Run methods

```bash
# DNS lookup (defaults to A records)
swamp model method run net-probe dns_lookup --input domain=example.com

# DNS lookup for MX records
swamp model method run net-probe dns_lookup --input domain=example.com --input recordType=MX

# HTTP endpoint check
swamp model method run net-probe http_check --input url=https://example.com

# WHOIS registration lookup
swamp model method run net-probe whois_lookup --input domain=example.com

# TLS certificate inspection
swamp model method run net-probe cert_check --input host=example.com

# Traceroute to a host
swamp model method run net-probe traceroute --input host=example.com

# TCP port connectivity check
swamp model method run net-probe port_check --input host=example.com --input ports=[80,443,8080]
```

### Examine stored resources

```yaml
# Resources written by each method:
# dns_lookup   -> dns_records/<domain>-<recordType>
# http_check   -> http_checks/<hostname>
# whois_lookup -> whois_info/<domain>
# cert_check   -> cert_info/<host>-<port>
# traceroute   -> traceroute/<host>
# port_check   -> port_scan/<host>
```

## Methods

| Method         | Description                                               |
| -------------- | --------------------------------------------------------- |
| `dns_lookup`   | Run dig to resolve DNS records for a domain               |
| `http_check`   | Fetch a URL and record status, headers, timing, redirects |
| `whois_lookup` | Query WHOIS for domain registration details               |
| `cert_check`   | Inspect TLS certificate subject, issuer, validity dates   |
| `traceroute`   | Trace network path to a host                              |
| `port_check`   | Test TCP connectivity on specific ports                   |

## Troubleshooting

### Command failures produce error resources, not exceptions

Every CLI-based method (dns_lookup, whois, cert_check, traceroute) writes a
resource with an `error` field populated on failure, rather than throwing. Check
the resource output's `error` and `commandError` fields for diagnostic details.

### `http_check` catches all fetch errors

Network failures, DNS resolution errors, and invalid URLs are caught and written
as error resources with `statusCode: 0`. The method never throws to the caller.

### `port_check` reports per-port independently

A connection failure on one port does not abort the scan. Each port produces an
`{ open: boolean, error?: string }` entry in the results array.

### `dns_lookup` falls back from `dig +json` to text parsing

If the `dig` binary does not support `+json` (indicated by "Invalid option" in
stderr), the method retries with standard text output and parses the text format
instead.

### 30-second command timeout (60s for traceroute)

CLI commands that exceed their timeout are killed. The resource is written with
the timeout error in the `error` field.

### No global args — all configuration is per-method

The model defines zero global arguments. Target hosts, ports, domains, and
options are passed per-method via `--input` arguments.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
