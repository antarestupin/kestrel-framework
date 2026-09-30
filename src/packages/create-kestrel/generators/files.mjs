import { parseDocument } from "yaml";

/** Fail on template drift instead of silently skipping a feature's composition point. */
export function replaceSource(generator, path, before, after) {
  const destination = generator.destinationPath(path);
  const source = generator.fs.read(destination);
  if (source.split(before).length !== 2) throw new Error(`Expected one composition point in ${path}.`);
  generator.fs.write(destination, source.replace(before, after));
}

/** Preserve Compose comments while features contribute services to the shared staged document. */
export function updateInfrastructure(generator, update) {
  const path = generator.destinationPath(".devcontainer/docker-compose.yml");
  const document = parseDocument(generator.fs.read(path));
  if (document.errors.length) throw document.errors[0];
  update(document);
  generator.fs.write(path, String(document));
  // Start every contributed infrastructure service, including development tools, but not the app container.
  const services = Object.keys(document.toJS().services).filter((name) => name !== "app");
  const manifestPath = generator.destinationPath("package.json");
  const manifest = generator.fs.readJSON(manifestPath);
  manifest.scripts["infra:up"] = `docker compose -f .devcontainer/docker-compose.yml up -d --wait ${services.join(" ")}`;
  generator.fs.writeJSON(manifestPath, manifest);
}
