# @webframp/exe-dev/vm

exe.dev VM lifecycle model for swamp. Wraps the [exe.dev HTTPS API](https://exe.dev/docs/https-api)
to manage VMs as typed, versioned swamp resources.

## Methods

| Method | Purpose |
|--------|---------|
| `setup` | Generate a fully-permissioned API token and store it in the vault |
| `sync` | Observe all VMs as a versioned fleet snapshot (full detail) |
| `create` | Provision a new VM |
| `destroy` | Delete one or more VMs (with pre-flight existence check) |
| `restart` | Restart a VM |
| `resize` | Change CPU, memory, or disk (with pre-flight existence check) |
| `stat` | Fetch CPU/memory/disk/IO metrics |
| `tag` | Add or remove tags |
| `exec` | Run a shell command on a VM via SSH |
| `comment` | Set or clear a VM comment |
| `share` | Manage public/private state, user shares, and share links |
| `shelley_versions` | Fan-out version check across the fleet |
| `shelley_upgrade` | Fan-out Shelley/Claude Code upgrade |

## Authentication

The model authenticates via a bearer token stored in your swamp vault. The
`setup` method handles token generation and vault storage automatically:

```bash
swamp model method run exe-dev setup
```

This requires SSH access to exe.dev (your SSH key must be registered). The
generated token includes permissions for all commands the model uses.

Alternatively, generate a token manually:

```bash
ssh exe.dev ssh-key generate-api-key --exp=30d \
  --cmds=help,ls,new,rm,restart,resize,tag,stat,whoami,comment,"shelley install","share show","share set-public","share set-private","share add","share remove","share add-link","share remove-link"
```

## Data Resources

| Resource | Description |
|----------|-------------|
| `fleet` | Full fleet snapshot (all VMs with sharing, resources, tags) |
| `vm` | Individual VM state after mutations |
| `stat` | VM metrics (CPU, memory, disk, IO) |
| `exec` | Shell command output from VMs |
| `shelleyVersions` | Shelley/Claude Code version per VM |
| `shelleyUpgrade` | Upgrade operation results |

## Examples

```bash
# Observe fleet
swamp model method run exe-dev sync

# Query public VMs
swamp data get exe-dev all --json | jq '.content.vms[] | select(.proxyShare == "public") | .vmName'

# Create a VM with tags
swamp model method run exe-dev create --input 'tags=["worker","ephemeral"]' --input 'comment=batch job'

# Check Shelley versions across fleet
swamp model method run exe-dev shelley_versions

# Upgrade all outdated VMs
swamp model method run exe-dev shelley_upgrade
```

## Requirements

- SSH key registered with exe.dev (`ssh exe.dev whoami` works)
- A swamp vault configured for token storage
- Network access to `https://exe.dev/exec` and `*.exe.xyz` (SSH for `exec` method)

## License

Apache-2.0
