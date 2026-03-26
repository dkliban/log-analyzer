# log-analyzer

Swamp-based automation for detecting slow Pulp API requests and filing Jira issues.

## Workflows

### `pulp-slow-request-monitor`

Scans the last hour of logs from all `pulp-api` pods in the `pulp-prod` OpenShift namespace. Any GET request that took longer than 30 seconds is extracted, grouped by normalized endpoint path (domain segment and UUIDs are replaced with `{domain}` and `{id}`), and filed as a Jira issue in the PULP project.

**Deduplication:** one Jira issue per unique endpoint. If an open issue already exists for that endpoint, a comment is added instead of opening a new issue.

**Jobs:**

1. `analyze-logs` — fetches logs from all running `pulp-api` pods and outputs slow endpoints
2. `manage-jira-issues` — creates or comments on Jira issues for each slow endpoint

## Prerequisites

- `oc` CLI installed and logged in to the OpenShift cluster with access to the `pulp-prod` namespace
- [swamp](https://github.com/systeminit/swamp) installed
- A Jira API token for `redhat.atlassian.net`

## Credential Setup

Credentials are stored in a local encrypted vault called `pulp-jira-creds`. Run these once from this repository directory:

```bash
swamp vault put pulp-jira-creds "JIRA_URL=https://redhat.atlassian.net"
swamp vault put pulp-jira-creds "JIRA_EMAIL=your-email@redhat.com"
swamp vault put pulp-jira-creds "JIRA_API_TOKEN=your-api-token"
```

To generate a Jira API token, visit: Account Settings → Security → API tokens at `https://id.atlassian.com/manage-profile/security/api-tokens`

## Running the Workflow

```bash
swamp workflow run pulp-slow-request-monitor --json
```

To inspect results after a run:

```bash
# Slow endpoints found in logs
swamp data get pulp-log-analysis main --json

# Jira actions taken (created / commented / skipped)
swamp data get pulp-jira main --json
```

## Configuration

The log analyzer defaults can be overridden by editing the `pulp-log-analysis` model instance:

```bash
swamp model edit pulp-log-analysis
```

| Setting | Default | Description |
|---|---|---|
| `namespace` | `pulp-prod` | OpenShift namespace |
| `sinceSeconds` | `3600` | How far back to look in logs |
| `thresholdSeconds` | `30` | Minimum request duration to flag |

## Running on a Schedule

To run the workflow automatically every hour:

```bash
swamp cron create "0 * * * *" "swamp workflow run pulp-slow-request-monitor" --json
```
