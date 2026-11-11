const { relative, resolve, sep } = require("node:path");

const sourceRoot = resolve(__dirname, "../../src/packages/kestrel/src");

module.exports = class BranchCoverageReporter {
  execute(context) {
    const components = new Map();
    context.getTree("flat").visit({
      onDetail(node) {
        const file = node.getFileCoverage();
        const segments = relative(sourceRoot, file.path).split(sep);
        const component = segments.length > 1 ? segments[0] : "(root)";
        const { covered, total } = file.toSummary().branches;

        // Sum branch counts so each branch contributes equally, including in nested adapters.
        const counts = components.get(component) ?? { covered: 0, total: 0 };
        counts.covered += covered;
        counts.total += total;
        components.set(component, counts);
      },
    });

    console.log("Kestrel branch coverage by component");
    console.table([...components.entries()].sort().map(([component, { covered, total }]) => ({
      Component: component,
      Covered: covered,
      Total: total,
      Coverage: total === 0 ? "N/A" : `${(100 * covered / total).toFixed(2)}%`,
    })));
  }
};
