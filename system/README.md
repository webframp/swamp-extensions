# @webframp/system

System diagnostics model for [swamp](https://github.com/systeminit/swamp). Provides operational visibility into local host health by querying disk usage, memory and swap consumption, process activity, uptime and load averages, network interfaces, and OS release information -- all through standard Unix shell commands.

## Prerequisites

This extension relies on standard Unix utilities that ship with most Linux distributions:

- `df` -- disk usage
- `free` -- memory and swap
- `uptime` -- boot time and load averages
- `ps` -- process listing
- `ip` -- network interface enumeration (iproute2)
- `uname` -- kernel version

No additional packages or cloud credentials are required.

## Installation

```bash
swamp extension pull @webframp/system
```

## Usage

Create a model instance and run any of the available diagnostic methods:

```bash
# Create a system diagnostics model instance
swamp model create @webframp/system sys-diag

# Get filesystem disk usage
swamp model method run sys-diag get_disk_usage

# Get memory and swap usage
swamp model method run sys-diag get_memory

# Get system uptime and load averages
swamp model method run sys-diag get_uptime

# Get top processes sorted by CPU (default 20)
swamp model method run sys-diag get_processes

# Get network interfaces and addresses
swamp model method run sys-diag get_network_interfaces

# Get OS release info and kernel version
swamp model method run sys-diag get_os_info
```

Each method writes its output to a typed resource that you can inspect or feed into workflows and reports.

### Example: disk usage output

```yaml
filesystems:
  - source: /dev/sda1
    fstype: ext4
    size: 50G
    used: 12G
    avail: 35G
    usePercent: 25%
    target: /
count: 1
fetchedAt: "2026-04-22T12:00:00.000Z"
```

## Methods

| Method | Description |
|--------|-------------|
| `get_disk_usage` | Filesystem usage from `df -h` |
| `get_memory` | Memory and swap usage from `free -h` |
| `get_uptime` | Boot time, uptime string, and 1/5/15-minute load averages |
| `get_processes` | Top N processes sorted by CPU (default 20) |
| `get_network_interfaces` | Network interfaces and addresses from `ip -j addr show` |
| `get_os_info` | OS release info from `/etc/os-release` and kernel version from `uname -a` |

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
