import { readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import Generator from "yeoman-generator";
import { createApplicationNames } from "../application_names.mjs";

/** Own input validation and choices; feature generators own the application files. */
export default class ApplicationGenerator extends Generator {
  async initializing() {
    this.destination = resolve(this.options.directory);
    this.applicationName = createApplicationNames(basename(this.destination)).applicationName;
    // Registry generation needs no local archive; explicit overrides still fail before writing.
    if (this.options.frameworkArchive !== undefined) {
      this.archive = resolve(this.options.frameworkArchive);
      if (!(await stat(this.archive)).isFile()) throw new Error("The framework archive must be a file.");
    }
    try {
      if ((await readdir(this.destination)).length) throw new Error("The destination must be empty.");
    } catch (error) {
      // Missing destinations are expected: Yeoman creates the application directory when committing files.
      if (error.code !== "ENOENT") throw error;
    }
    if (this.options.cache !== undefined && !["postgres", "redis"].includes(this.options.cache)) {
      throw new Error("Cache must be postgres or redis.");
    }
    if (this.options.atlas !== undefined && typeof this.options.atlas !== "boolean") {
      throw new Error("Atlas must be a boolean.");
    }
    this.destinationRoot(this.destination);
  }

  async prompting() {
    this.cache = this.options.cache;
    if (this.cache === undefined && this.options.interactive) {
      const answers = await this.prompt([{
        type: "select", name: "cache", message: "Which cache backend do you want to use?",
        choices: [{ name: "PostgreSQL", value: "postgres" }, { name: "Redis", value: "redis" }],
        default: "postgres",
      }]);
      this.cache = answers.cache;
    }
    this.cache ??= "postgres";
    this.atlas = this.options.atlas;
    // Explicit positive and negative choices both suppress the feature question.
    if (this.atlas === undefined && this.options.interactive) {
      const answers = await this.prompt([{
        type: "confirm", name: "atlas", message: "Do you want to include Atlas?", default: true,
      }]);
      this.atlas = answers.atlas;
    }
    // Noninteractive creation uses the same default as accepting the prompt.
    this.atlas ??= true;
    // Infrastructure availability is explicit so future Redis consumers can contribute here.
    this.redisInstalled = this.cache === "redis";
  }

  async configuring() {
    const options = { destination: this.destination, applicationName: this.applicationName, archive: this.archive, cache: this.cache };
    // All generators share Yeoman's staged filesystem and ordered lifecycle.
    await this.composeWith("kestrel:base", options);
    await this.composeWith("kestrel:cache", options);
    if (this.redisInstalled) await this.composeWith("kestrel:redis", options);
    if (this.atlas) await this.composeWith("kestrel:atlas", options);
  }

  end() {
    this.log(`Created ${this.destination} with ${this.cache} cache${this.atlas ? " and Atlas" : ""}. Run npm install, npm run build:ai, and npm run test:ai there.`);
  }
}
