import { z } from "npm:zod@4";

// Log format:
// (pulp [%({correlation-id}o)s]: %(h)s %(l)s user:%({REMOTE_USER}e)s org_id:%({ORG_ID}e)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(M)s x_forwarded_for:"%({X-Forwarded-For}i)s")
const LOG_RE =
  /^\(pulp \[(?<corrId>[^\]]*)\]: (?<host>\S+) (?<logname>\S+) user:(?<user>\S+) org_id:(?<orgId>\S+) \[(?<timestamp>[^\]]+)\] "(?<request>[^"]*)" (?<status>\d+) (?<bytes>\S+) "(?<referer>[^"]*)" "(?<ua>[^"]*)" (?<durationMs>\d+) x_forwarded_for:"(?<xff>[^"]*)"\)$/;

const SLO_GROUPS = [
  { name: "GET",     availabilityTarget: 99.9, latencyP95Target: 2000 },
  { name: "PUT",     availabilityTarget: 99.0, latencyP95Target: 1000 },
  { name: "POST",    availabilityTarget: 99.0, latencyP95Target: 1000 },
  { name: "DELETE",  availabilityTarget: 99.0, latencyP95Target: 1000 },
  { name: "PATCH",   availabilityTarget: 99.0, latencyP95Target: 1000 },
  { name: "HEAD",    availabilityTarget: 99.9, latencyP95Target:  500 },
  { name: "OPTIONS", availabilityTarget: 99.9, latencyP95Target:  500 },
] as const;

const SloGroupResultSchema = z.object({
  totalRequests:       z.number(),
  errorCount:          z.number(),
  availability:        z.number(),
  availabilityTarget:  z.number(),
  availabilityMet:     z.boolean(),
  p50Ms:               z.number(),
  p95Ms:               z.number(),
  p99Ms:               z.number(),
  latencyP95Target:    z.number(),
  latencyMet:          z.boolean(),
});

const SloResultsSchema = z.object({
  collectedAt:  z.iso.datetime(),
  windowStart:  z.iso.datetime().optional(),
  windowEnd:    z.iso.datetime().optional(),
  namespace:    z.string(),
  podSelector:  z.string(),
  pods:         z.array(z.string()),
  totalLines:   z.number(),
  parsedLines:  z.number(),
  groups:       z.record(z.string(), SloGroupResultSchema),
});

const GlobalArgsSchema = z.object({
  namespace:   z.string().default("pulp-prod"),
  podSelector: z.string().default("pod=pulp-api"),
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const LOG_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseLogTimestamp(ts: string): number | null {
  // Format: 25/Mar/2026:20:05:13 +0000
  const m = /(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/.exec(ts);
  if (!m) return null;
  const month = LOG_MONTHS[m[2]];
  if (month === undefined) return null;
  const sign = m[7][0] === "+" ? 1 : -1;
  const offsetMs = sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10)) * 60000;
  return Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) - offsetMs;
}

export const model = {
  type: "@dkliban/pulp-log-collector",
  version: "2026.03.25.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    sloResults: {
      description: "SLO analysis results grouped by HTTP method",
      schema: SloResultsSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },

  files: {
    rawLogs: {
      description: "Raw concatenated access logs from all pods",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },

  reports: ["@dkliban/pulp-slo-report"],

  methods: {
    collect: {
      description:
        "Collect access logs from all matching pods and compute per-method SLOs",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { namespace, podSelector } = context.globalArgs;

        context.logger.info(
          `Getting pods: namespace=${namespace} selector=${podSelector}`,
        );
        const podListOut = await new Deno.Command("oc", {
          args: [
            "get", "pods",
            "-n", namespace,
            "-l", podSelector,
            "-o", "jsonpath={.items[*].metadata.name}",
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();

        if (!podListOut.success) {
          const stderr = new TextDecoder().decode(podListOut.stderr);
          throw new Error(`oc get pods failed: ${stderr}`);
        }

        const podsStr = new TextDecoder().decode(podListOut.stdout).trim();
        if (!podsStr) {
          throw new Error(
            `No pods found matching selector "${podSelector}" in namespace "${namespace}"`,
          );
        }
        const pods = podsStr.split(/\s+/);
        context.logger.info(`Found ${pods.length} pod(s): ${pods.join(", ")}`);

        type Stats = { total: number; errors: number; latencies: number[] };
        const groupStats: Record<string, Stats> = {};
        for (const g of SLO_GROUPS) {
          groupStats[g.name] = { total: 0, errors: 0, latencies: [] };
        }

        const logWriter = context.createFileWriter("rawLogs", "rawLogs-collected", {
          streaming: true,
        });

        let totalLines = 0;
        let parsedLines = 0;
        let minTs: number | null = null;
        let maxTs: number | null = null;

        for (const pod of pods) {
          context.logger.info(`Fetching logs from pod: ${pod}`);
          const logsOut = await new Deno.Command("oc", {
            args: ["logs", "-n", namespace, pod],
            stdout: "piped",
            stderr: "piped",
          }).output();

          if (!logsOut.success) {
            context.logger.warn(`Failed to get logs from ${pod}, skipping`);
            continue;
          }

          const logsText = new TextDecoder().decode(logsOut.stdout);
          await logWriter.writeLine(`=== ${pod} ===`);

          for (const line of logsText.split("\n")) {
            if (!line.trim()) continue;
            totalLines++;
            await logWriter.writeLine(line);

            const m = LOG_RE.exec(line);
            if (!m?.groups) continue;
            parsedLines++;

            const { request, status, durationMs, timestamp } = m.groups;
            const method = request.split(" ")[0] ?? "";
            const statusCode = parseInt(status, 10);
            const latency = parseInt(durationMs, 10);
            const tsMs = parseLogTimestamp(timestamp);
            if (tsMs !== null) {
              if (minTs === null || tsMs < minTs) minTs = tsMs;
              if (maxTs === null || tsMs > maxTs) maxTs = tsMs;
            }

            const stats = groupStats[method];
            if (stats) {
              stats.total++;
              if (statusCode >= 500) stats.errors++;
              stats.latencies.push(latency);
            }
          }
        }

        const rawLogsHandle = await logWriter.finalize();
        context.logger.info(
          `Parsed ${parsedLines.toLocaleString()} / ${totalLines.toLocaleString()} lines`,
        );

        const groups: Record<string, z.infer<typeof SloGroupResultSchema>> = {};
        for (const g of SLO_GROUPS) {
          const stats = groupStats[g.name];
          const sorted = [...stats.latencies].sort((a, b) => a - b);
          const errorRate =
            stats.total > 0 ? (stats.errors / stats.total) * 100 : 0;
          const availability = 100 - errorRate;
          const p95 = percentile(sorted, 95);
          groups[g.name] = {
            totalRequests:      stats.total,
            errorCount:         stats.errors,
            availability:       Math.round(availability * 1000) / 1000,
            availabilityTarget: g.availabilityTarget,
            availabilityMet:    availability >= g.availabilityTarget,
            p50Ms:              percentile(sorted, 50),
            p95Ms:              p95,
            p99Ms:              percentile(sorted, 99),
            latencyP95Target:   g.latencyP95Target,
            latencyMet:         stats.total === 0 || p95 <= g.latencyP95Target,
          };
        }

        const collectedAt = new Date().toISOString();
        const instanceName = `sloResults-${collectedAt.replace(/:/g, "-")}`;
        const sloHandle = await context.writeResource(
          "sloResults",
          instanceName,
          {
            collectedAt,
            ...(minTs !== null ? { windowStart: new Date(minTs).toISOString() } : {}),
            ...(maxTs !== null ? { windowEnd: new Date(maxTs).toISOString() } : {}),
            namespace,
            podSelector,
            pods,
            totalLines,
            parsedLines,
            groups,
          },
        );

        return { dataHandles: [sloHandle, rawLogsHandle] };
      },
    },
  },
};
