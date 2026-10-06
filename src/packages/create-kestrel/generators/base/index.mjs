import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";
import { createApplicationNames, renderApplicationTemplate } from "../application_names.mjs";

/** Stage the canonical application, including dotfiles and executable launchers. */
export default class BaseGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    const names = createApplicationNames(this.options.applicationName);
    this.fs.copy(fileURLToPath(new URL("../../template/", import.meta.url)), this.destinationPath(), {
      globOptions: { dot: true },
      // Preserve file modes and untouched bytes, including any future binary assets.
      fileTransform: ({ destinationPath, contents }) => ({
        path: destinationPath,
        contents: contents.includes("__KESTREL_") ? renderApplicationTemplate(contents.toString(), names) : contents,
      }),
    });
    // npm excludes .gitignore from archives; keep its source under a packaging-safe name.
    this.fs.move(this.destinationPath("gitignore"), this.destinationPath(".gitignore"));
    const manifestPath = this.destinationPath("package.json");
    const manifest = this.fs.readJSON(manifestPath);
    manifest.name = names.applicationName;
    // Retain the template's exact compatible prerelease unless a local archive is supplied.
    if (this.options.archive !== undefined) {
      this.fs.copy(this.options.archive, this.destinationPath("vendor/framework.tgz"));
      manifest.dependencies["@kestreljs/framework"] = "file:vendor/framework.tgz";
    }
    this.fs.writeJSON(manifestPath, manifest);
  }
}
