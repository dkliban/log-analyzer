import { z } from "npm:zod@4";

// Log format:
// <host> [<timestamp>] "<request>" <status> <bytes> "<referer>" "<ua>" cache:"<cache>" artifact_size:"<size>" rh_org_id:"<org_id>" x_forwarded_for:"<xff>"
const LOG_RE =
  /^(?<host>\S+) \[(?<timestamp>[^\]]+)\] "(?<request>[^"]*)" (?<status>\d+) (?<bytes>\S+) "(?<referer>[^"]*)" "(?<ua>[^"]*)" cache:"(?<cache>[^"]*)" artifact_size:"(?<artifactSize>[^"]*)" rh_org_id:"(?<orgId>[^"]*)" x_forwarded_for:"(?<xff>[^"]*)"$/;

const SLO_GROUPS = [
  { name: "GET",     availabilityTarget: 99.9 },
  { name: "PUT",     availabilityTarget: 99.0 },
  { name: "POST",    availabilityTarget: 99.0 },
  { name: "DELETE",  availabilityTarget: 99.0 },
  { name: "PATCH",   availabilityTarget: 99.0 },
  { name: "HEAD",    availabilityTarget: 99.9 },
  { name: "OPTIONS", availabilityTarget: 99.9 },
] as const;

const SloGroupResultSchema = z.object({
  totalRequests:      z.number(),
  errorCount:         z.number(),
  availability:       z.number(),
  availabilityTarget: z.number(),
  availabilityMet:    z.boolean(),
  cacheHits:          z.number(),
  cacheMisses:        z.number(),
  cacheHitRate:       z.number(),
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
  podSelector: z.string().default("pod=pulp-content"),
});

const LOG_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseLogTimestamp(ts: string): number | null {
  const m = /(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/.exec(ts);
  if (!m) return null;
  const month = LOG_MONTHS[m[2]];
  if (month === undefined) return null;
  const sign = m[7][0] === "+" ? 1 : -1;
  const offsetMs = sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10)) * 60000;
  return Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) - offsetMs;
}

export const model = {
  type: "@dkliban/pulp-content-log-collector",
  version: "2026.03.25.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    sloResults: {
      description: "Availability SLO results grouped by HTTP method",
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

  reports: ["@dkliban/pulp-content-slo-report"],

  methods: {
    collect: {
      description:
        "Collect access logs from all matching pods and compute per-method availability SLOs",
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

        type Stats = { total: number; errors: number; cacheHits: number; cacheMisses: number };
        const groupStats: Record<string, Stats> = {};
        for (const g of SLO_GROUPS) {
          groupStats[g.name] = { total: 0, errors: 0, cacheHits: 0, cacheMisses: 0 };
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

            const { request, status, timestamp, cache } = m.groups;
            const method = request.split(" ")[0] ?? "";
            const statusCode = parseInt(status, 10);

            const tsMs = parseLogTimestamp(timestamp);
            if (tsMs !== null) {
              if (minTs === null || tsMs < minTs) minTs = tsMs;
              if (maxTs === null || tsMs > maxTs) maxTs = tsMs;
            }

            const stats = groupStats[method];
            if (stats) {
              stats.total++;
              if (statusCode >= 500) stats.errors++;
              if (cache === "HIT") stats.cacheHits++;
              else if (cache === "MISS") stats.cacheMisses++;
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
          const errorRate = stats.total > 0 ? (stats.errors / stats.total) * 100 : 0;
          const availability = 100 - errorRate;
          const cacheableRequests = stats.cacheHits + stats.cacheMisses;
          groups[g.name] = {
            totalRequests:      stats.total,
            errorCount:         stats.errors,
            availability:       Math.round(availability * 1000) / 1000,
            availabilityTarget: g.availabilityTarget,
            availabilityMet:    availability >= g.availabilityTarget,
            cacheHits:          stats.cacheHits,
            cacheMisses:        stats.cacheMisses,
            cacheHitRate:       cacheableRequests > 0
              ? Math.round((stats.cacheHits / cacheableRequests) * 1000) / 10
              : 0,
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
