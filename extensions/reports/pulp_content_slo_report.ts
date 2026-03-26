function sloRows(slo) {
  return Object.entries(slo.groups)
    .map(([method, g]) => {
      const avail = g.availability.toFixed(3);
      const availMet = g.availabilityMet ? "✓" : "✗";
      const hitRate = g.cacheHitRate !== undefined
        ? `${g.cacheHitRate.toFixed(1)}%`
        : "N/A";
      return (
        `| ${method.padEnd(7)} ` +
        `| ${String(g.totalRequests).padStart(9)} ` +
        `| ${String(g.errorCount).padStart(6)} ` +
        `| ${avail}% | ${g.availabilityTarget}% | ${availMet} ` +
        `| ${String(g.cacheHits ?? 0).padStart(9)} ` +
        `| ${String(g.cacheMisses ?? 0).padStart(9)} ` +
        `| ${hitRate.padStart(8)} |`
      );
    })
    .join("\n");
}

export const report = {
  name: "@dkliban/pulp-content-slo-report",
  description: "Availability SLO compliance table per HTTP method for pulp-content",
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
        const head = snap.groups["HEAD"];
        const ts = snap.collectedAt.replace("T", " ").replace(".000Z", "Z").replace(/\.\d+Z$/, "Z");
        return (
          `| ${ts} ` +
          `| ${String(get?.totalRequests ?? 0).padStart(9)} ` +
          `| ${(get?.availability ?? 100).toFixed(3)}% ` +
          `| ${(get?.cacheHitRate ?? 0).toFixed(1)}% ` +
          `| ${String(head?.totalRequests ?? 0).padStart(6)} ` +
          `| ${(head?.cacheHitRate ?? 0).toFixed(1)}% |`
        );
      }),
    );

    const markdown = [
      "# Pulp Content SLO Report",
      "",
      `**Collected:** ${slo.collectedAt}  `,
      ...(windowLine ? [windowLine] : []),
      `**Pods:** ${slo.pods.join(", ")}  `,
      `**Lines parsed:** ${slo.parsedLines.toLocaleString()} / ${slo.totalLines.toLocaleString()}`,
      "",
      "| Method  | Requests  | Errors | Avail %   | Target | Met | Cache Hits | Cache Miss | Hit Rate |",
      "|---------|-----------|--------|-----------|--------|-----|------------|------------|----------|",
      sloRows(slo),
      "",
      "## Historical Trend",
      "",
      "| Collected At        | GET Reqs  | GET Avail | GET Hit % | HEAD Reqs | HEAD Hit % |",
      "|---------------------|-----------|-----------|-----------|-----------|------------|",
      ...trendRows.filter(Boolean),
      "",
    ].join("\n");

    return { markdown, json: slo };
  },
};
