const { relative, resolve, sep } = require("node:path");

const sourceRoot = resolve(__dirname, "../../src/packages/kestrel/src");

module.exports = class BranchCoverageReporter {
  execute(context) {
    const components = new Map();
    const adminParts = new Map();
    context.getTree("flat").visit({
      onDetail(node) {
        const file = node.getFileCoverage();
        const segments = relative(sourceRoot, file.path).split(sep);
        const component = segments.length > 1 ? segments[0] : "(root)";
        const { covered, total } = file.toSummary().branches;

        // Sum branch counts so each branch contributes equally, including in nested adapters.
        addBranches(components, component, covered, total);
        if (component === "atlas" || component === "studio") {
          // Server delivery adapters also use a directory named client.
          const browser = (segments[1] === "client" && segments[2] === "src")
            || (component === "studio" && segments[1] === "extensions" && segments[3] === "client");
          addBranches(adminParts, `${component} ${browser ? "client" : "server"}`, covered, total);
        }
      },
    });

    printBranches("Kestrel branch coverage by component", components);
    if (adminParts.size > 0) {
      printBranches("Atlas and Studio branch coverage by runtime", adminParts);
    }
  }
};

function addBranches(groups, name, covered, total) {
  const counts = groups.get(name) ?? { covered: 0, total: 0 };
  counts.covered += covered;
  counts.total += total;
  groups.set(name, counts);
}

function printBranches(title, groups) {
  console.log(title);
  console.table([...groups.entries()].sort().map(([component, { covered, total }]) => ({
    Component: component,
    Covered: covered,
    Total: total,
    Coverage: total === 0 ? "N/A" : `${(100 * covered / total).toFixed(2)}%`,
  })));
}
