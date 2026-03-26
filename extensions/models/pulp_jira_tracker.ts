import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  jiraUrl: z.string().describe("Jira base URL (e.g. https://issues.redhat.com)"),
  jiraEmail: z.string().describe("Jira account email"),
  jiraApiToken: z.string().meta({ sensitive: true }).describe("Jira API token"),
  projectKey: z.string().default("PULP").describe("Jira project key"),
});

const SlowEndpointSchema = z.object({
  path: z.string(),
  maxDurationSeconds: z.number(),
  occurrenceCount: z.number(),
  exampleLogLine: z.string(),
});

const IssueActionSchema = z.object({
  endpoint: z.string(),
  action: z.enum(["created", "commented", "skipped"]),
  issueKey: z.string().optional(),
  issueUrl: z.string().optional(),
});

const IssueActionsSchema = z.object({
  results: z.array(IssueActionSchema),
  processedAt: z.string(),
});

const SLOW_REQUEST_LABEL = "pulp-slow-api-request";

function buildIssueSummary(path: string): string {
  return `Slow API request detected: ${path}`;
}

function buildIssueDescription(endpoint: z.infer<typeof SlowEndpointSchema>): object {
  // Jira Atlassian Document Format (ADF)
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `A slow API request was detected on the pulp-api service exceeding the 30-second threshold.`,
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: `Endpoint: ${endpoint.path}` }],
            }],
          },
          {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: `Max duration: ${endpoint.maxDurationSeconds.toFixed(2)}s` }],
            }],
          },
          {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: `Occurrences: ${endpoint.occurrenceCount}` }],
            }],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Example log line:" }],
      },
      {
        type: "codeBlock",
        content: [{ type: "text", text: endpoint.exampleLogLine }],
      },
    ],
  };
}

function buildCommentBody(endpoint: z.infer<typeof SlowEndpointSchema>): object {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `Slow request detected again on ${new Date().toISOString()}`,
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: `Max duration: ${endpoint.maxDurationSeconds.toFixed(2)}s` }],
            }],
          },
          {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: `Occurrences in this window: ${endpoint.occurrenceCount}` }],
            }],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Example log line:" }],
      },
      {
        type: "codeBlock",
        content: [{ type: "text", text: endpoint.exampleLogLine }],
      },
    ],
  };
}

export const model = {
  type: "@dkliban/pulp-jira-tracker",
  version: "2026.03.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    issue_actions: {
      description: "Results of Jira issue creation/update for slow endpoints",
      schema: IssueActionsSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure_issues: {
      description: "Create or comment on Jira issues for each slow endpoint (deduplicated by normalized path)",
      arguments: z.object({
        endpoints: z.array(SlowEndpointSchema).describe("Slow endpoints from pulp-log-analyzer"),
      }),
      execute: async (args, context) => {
        const { jiraUrl, jiraEmail, jiraApiToken, projectKey } = context.globalArgs;
        const baseUrl = jiraUrl.replace(/\/$/, "");
        const authHeader = `Basic ${btoa(`${jiraEmail}:${jiraApiToken}`)}`;
        const headers = {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          "Accept": "application/json",
        };

        if (args.endpoints.length === 0) {
          context.logger.info("No slow endpoints to process.");
          const handle = await context.writeResource("issue_actions", "main", {
            results: [],
            processedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        context.logger.info(`Processing ${args.endpoints.length} slow endpoint(s)...`);
        const results: z.infer<typeof IssueActionSchema>[] = [];

        for (const endpoint of args.endpoints) {
          const summary = buildIssueSummary(endpoint.path);

          // Search for an existing open issue with this endpoint
          const jql = `project = "${projectKey}" AND labels = "${SLOW_REQUEST_LABEL}" AND summary ~ "${endpoint.path.replace(/"/g, '\\"')}" AND statusCategory != Done`;
          const searchUrl = `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=1&fields=id,key,summary,status`;

          context.logger.info(`Searching Jira for existing issue: ${endpoint.path}`);
          const searchResp = await fetch(searchUrl, { headers });
          if (!searchResp.ok) {
            const body = await searchResp.text();
            throw new Error(`Jira search failed for ${endpoint.path}: ${searchResp.status} ${body}`);
          }

          const searchData = await searchResp.json();

          if (searchData.issues && searchData.issues.length > 0) {
            // Existing open issue — add a comment
            const issue = searchData.issues[0];
            context.logger.info(`Found existing issue ${issue.key}, adding comment.`);

            const commentUrl = `${baseUrl}/rest/api/3/issue/${issue.key}/comment`;
            const commentResp = await fetch(commentUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({ body: buildCommentBody(endpoint) }),
            });

            if (!commentResp.ok) {
              const body = await commentResp.text();
              throw new Error(`Failed to comment on ${issue.key}: ${commentResp.status} ${body}`);
            }

            results.push({
              endpoint: endpoint.path,
              action: "commented",
              issueKey: issue.key,
              issueUrl: `${baseUrl}/browse/${issue.key}`,
            });
          } else {
            // No open issue — create one
            context.logger.info(`No existing issue found for ${endpoint.path}, creating new issue.`);

            const createUrl = `${baseUrl}/rest/api/3/issue`;
            const createResp = await fetch(createUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                fields: {
                  project: { key: projectKey },
                  summary,
                  description: buildIssueDescription(endpoint),
                  issuetype: { name: "Bug" },
                  labels: [SLOW_REQUEST_LABEL],
                },
              }),
            });

            if (!createResp.ok) {
              const body = await createResp.text();
              throw new Error(`Failed to create issue for ${endpoint.path}: ${createResp.status} ${body}`);
            }

            const created = await createResp.json();
            results.push({
              endpoint: endpoint.path,
              action: "created",
              issueKey: created.key,
              issueUrl: `${baseUrl}/browse/${created.key}`,
            });
          }
        }

        const handle = await context.writeResource("issue_actions", "main", {
          results,
          processedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
