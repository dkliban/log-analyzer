function sloRows(slo) {
  return Object.entries(slo.groups)
    .map(([method, g]) => {
      const avail = g.availability.toFixed(3);
      const availMet = g.availabilityMet ? "✓" : "✗";
      const latMet = g.latencyMet ? "✓" : "✗";
      return (
        `| ${method.padEnd(7)} ` +
        `| ${String(g.totalRequests).padStart(9)} ` +
        `| ${String(g.errorCount).padStart(6)} ` +
        `| ${avail}% | ${g.availabilityTarget}% | ${availMet} ` +
        `| ${String(g.p50Ms).padStart(6)} ` +
        `| ${String(g.p95Ms).padStart(6)} ` +
        `| ${String(g.p99Ms).padStart(6)} ` +
        `| ${g.latencyP95Target} ms | ${latMet} |`
      );
    })
    .join("\n");
}

export const report = {
  name: "@dkliban/pulp-slo-report",
  description: "SLO compliance table per HTTP method for pulp-api",
  scope: "method",
  labels: ["slo"],
  execute: async (context) => {
    const handle = context.dataHandles.find(
      (h) => h.specName === "sloResults",
    );
    if (!handle) {
      return { markdown: "No SLO results found.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
    );
    if (!raw) {
      return { markdown: "No SLO data available.", json: {} };
    }

    const slo = JSON.parse(new TextDecoder().decode(raw));

    const windowLine = slo.windowStart && slo.windowEnd
      ? `**Window:** ${slo.windowStart} → ${slo.windowEnd}  `
      : null;

    // Load all historical sloResults instances for trend table
    const allData = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
    const snapshots = allData
      .filter((d) => d.tags?.["specName"] === "sloResults")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const trendRows = await Promise.all(
      snapshots.map(async (d) => {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          d.name,
        );
        if (!content) return null;
        const snap = JSON.parse(new TextDecoder().decode(content));
        const get = snap.groups["GET"];
        const post = snap.groups["POST"];
        const del = snap.groups["DELETE"];
        const ts = snap.collectedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
        const latIcon = (met) => met ? "✓" : "✗";
        return (
          `| ${ts} ` +
          `| ${String(get?.totalRequests ?? 0).padStart(7)} ` +
          `| ${String(get?.p95Ms ?? 0).padStart(6)} ${latIcon(get?.latencyMet)} ` +
          `| ${String(post?.totalRequests ?? 0).padStart(6)} ` +
          `| ${String(post?.p95Ms ?? 0).padStart(6)} ${latIcon(post?.latencyMet)} ` +
          `| ${String(del?.totalRequests ?? 0).padStart(6)} ` +
          `| ${String(del?.p95Ms ?? 0).padStart(7)} ${latIcon(del?.latencyMet)} |`
        );
      }),
    );

    const markdown = [
      "# Pulp API SLO Report",
      "",
      `**Collected:** ${slo.collectedAt}  `,
      ...(windowLine ? [windowLine] : []),
      `**Pods:** ${slo.pods.join(", ")}  `,
      `**Lines parsed:** ${slo.parsedLines.toLocaleString()} / ${slo.totalLines.toLocaleString()}`,
      "",
      "| Method  | Requests  | Errors | Avail %   | Target | Met | p50 ms | p95 ms | p99 ms | Target   | Met |",
      "|---------|-----------|--------|-----------|--------|-----|--------|--------|--------|----------|-----|",
      sloRows(slo),
      "",
      "## Historical Trend",
      "",
      "| Collected At        | GET Reqs | GET p95 | POST Reqs | POST p95 | DEL Reqs | DEL p95  |",
      "|---------------------|----------|---------|-----------|----------|----------|----------|",
      ...trendRows.filter(Boolean),
      "",
    ].join("\n");

    return { markdown, json: slo };
  },
};
