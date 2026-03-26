import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  namespace: z.string().default("pulp-prod").describe("OpenShift namespace"),
  sinceSeconds: z.number().default(3600).describe("How far back to look in logs (seconds)"),
  thresholdSeconds: z.number().default(30).describe("Request duration threshold in seconds"),
});

const SlowEndpointSchema = z.object({
  path: z.string(),
  maxDurationSeconds: z.number(),
  occurrenceCount: z.number(),
  exampleLogLine: z.string(),
});

const SlowRequestsSchema = z.object({
  endpoints: z.array(SlowEndpointSchema),
  podsAnalyzed: z.array(z.string()),
  analyzedAt: z.string(),
});

// Normalize a request path:
// 1. Replace the domain segment: /api/pulp/<domain>/ -> /api/pulp/{domain}/
// 2. Replace UUIDs with {id}
function normalizePath(path: string): string {
  // Normalize pulp domain segment
  let normalized = path.replace(
    /^(\/api\/pulp\/)[^/]+(\/)/,
    "$1{domain}$2",
  );
  // Normalize UUIDs
  normalized = normalized.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "{id}",
  );
  return normalized;
}

// Parse a single pulp-api log line.
// Format: (pulp [<id>]: <ip> - user:<u> org_id:<o> [<date>] "METHOD /path HTTP/1.1" <status> <bytes> "<ref>" "<ua>" <duration_ms> x_forwarded_for:"<ip>")
function parseLogLine(line: string): { method: string; path: string; status: number; durationSeconds: number } | null {
  const m = line.match(
    /"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^ ]+) HTTP\/[0-9.]+" (\d{3}) \d+ "[^"]*" "[^"]*" (\d+) x_forwarded_for:/,
  );
  if (!m) return null;
  return {
    method: m[1],
    path: m[2],
    status: parseInt(m[3]),
    durationSeconds: parseInt(m[4]) / 1000,
  };
}

export const model = {
  type: "@dkliban/pulp-log-analyzer",
  version: "2026.03.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    slow_requests: {
      description: "Slow API requests detected from pulp-api pod logs",
      schema: SlowRequestsSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    analyze: {
      description: "Fetch logs from all pulp-api pods and extract requests exceeding the duration threshold",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { namespace, sinceSeconds, thresholdSeconds } = context.globalArgs;

        // Discover pulp-api pods
        const getPods = new Deno.Command("oc", {
          args: ["get", "pods", "-n", namespace, "-l", "pod=pulp-api", "-o", "json"],
          stdout: "piped",
          stderr: "piped",
        });
        const podsResult = await getPods.output();
        if (!podsResult.success) {
          const stderr = new TextDecoder().decode(podsResult.stderr);
          throw new Error(`Failed to list pulp-api pods: ${stderr}`);
        }

        const podsJson = JSON.parse(new TextDecoder().decode(podsResult.stdout));
        const pods: string[] = podsJson.items
          .filter((p: { status?: { phase?: string } }) => p.status?.phase === "Running")
          .map((p: { metadata: { name: string } }) => p.metadata.name);

        if (pods.length === 0) {
          throw new Error(`No running pulp-api pods found in namespace ${namespace}`);
        }

        context.logger.info(`Found ${pods.length} pulp-api pods: ${pods.join(", ")}`);

        // Collect slow requests across all pods (fan-out within single method)
        const endpointMap = new Map<string, { maxDurationSeconds: number; occurrenceCount: number; exampleLogLine: string }>();

        for (const pod of pods) {
          context.logger.info(`Fetching logs from pod ${pod}...`);

          const getLogs = new Deno.Command("oc", {
            args: ["logs", "-n", namespace, pod, `--since=${sinceSeconds}s`],
            stdout: "piped",
            stderr: "piped",
          });
          const logsResult = await getLogs.output();
          if (!logsResult.success) {
            const stderr = new TextDecoder().decode(logsResult.stderr);
            context.logger.warn(`Failed to get logs from pod ${pod}: ${stderr}`);
            continue;
          }

          const logs = new TextDecoder().decode(logsResult.stdout);
          const lines = logs.split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = parseLogLine(line);
            if (!parsed) continue;
            if (parsed.method !== "GET") continue;
            if (parsed.durationSeconds <= thresholdSeconds) continue;

            const normalizedPath = normalizePath(parsed.path);
            const existing = endpointMap.get(normalizedPath);

            if (!existing || parsed.durationSeconds > existing.maxDurationSeconds) {
              endpointMap.set(normalizedPath, {
                maxDurationSeconds: parsed.durationSeconds,
                occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
                exampleLogLine: line.substring(0, 500),
              });
            } else {
              existing.occurrenceCount += 1;
            }
          }
        }

        const endpoints = Array.from(endpointMap.entries()).map(([path, data]) => ({
          path,
          ...data,
        }));

        context.logger.info(
          `Analysis complete. Found ${endpoints.length} slow endpoint(s) across ${pods.length} pod(s).`,
        );

        const handle = await context.writeResource("slow_requests", "main", {
          endpoints,
          podsAnalyzed: pods,
          analyzedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
