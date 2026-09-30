import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";

/** Stage the canonical application, including dotfiles and executable launchers. */
export default class BaseGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    this.fs.copy(fileURLToPath(new URL("../../template/", import.meta.url)), this.destinationPath(), { globOptions: { dot: true } });
    // npm excludes .gitignore from archives; keep its source under a packaging-safe name.
    this.fs.move(this.destinationPath("gitignore"), this.destinationPath(".gitignore"));
    this.fs.copy(this.options.archive, this.destinationPath("vendor/framework.tgz"));
    const manifestPath = this.destinationPath("package.json");
    const manifest = this.fs.readJSON(manifestPath);
    manifest.name = this.options.applicationName;
    manifest.dependencies["@kestrel/framework"] = "file:vendor/framework.tgz";
    this.fs.writeJSON(manifestPath, manifest);
  }
}
