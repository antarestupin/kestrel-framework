import { fileURLToPath } from "node:url";
import Generator from "yeoman-generator";
import { replaceSource } from "../files.mjs";

/** Add application-owned Atlas composition using the framework's packaged browser. */
export default class AtlasGenerator extends Generator {
  writing() {
    this.destinationRoot(this.options.destination);
    const templates = fileURLToPath(new URL("./templates/", import.meta.url));
    this.fs.copy(`${templates}/atlas.ts`, this.destinationPath("src/admin/index.ts"));
    this.fs.copy(`${templates}/config.ts`, this.destinationPath("src/server/core/config/backoffice.ts"));
    this.fs.copy(`${templates}/atlas_provider.ts`, this.destinationPath("src/server/core/providers/atlas_provider.ts"));
    this.fs.copy(`${templates}/atlas.test.ts.ejs`, this.destinationPath("src/admin/index.test.ts"));
    replaceSource(this, "src/server/core/app_config.ts", 'import { createStudioConfig } from "./config/studio.js";',
      'import { createStudioConfig } from "./config/studio.js";\nimport { createBackofficeConfig } from "./config/backoffice.js";');
    replaceSource(this, "src/server/core/app_config.ts", "  studio: createStudioConfig(configurationApi),",
      "  studio: createStudioConfig(configurationApi),\n  backoffice: createBackofficeConfig(configurationApi),");
    replaceSource(this, "src/server/core/app.ts", 'import { StudioProvider } from "./providers/studio_provider.js";',
      'import { StudioProvider } from "./providers/studio_provider.js";\nimport { ApplicationAtlasProvider } from "./providers/atlas_provider.js";\nimport { applicationBackoffice } from "../../admin/index.js";');
    replaceSource(this, "src/server/core/app.ts", "// Register Studio after every provider contributing definitions to its explorers.",
      '// Atlas serves packaged assets and exposes only explicitly registered resources.\napp.register(new ApplicationAtlasProvider(app.config.backoffice));\n\n// Register Studio after every provider contributing definitions to its explorers.');
    // Disabled Atlas needs explicit 404 routes; enabled Atlas already owns those paths.
    replaceSource(this, "src/server/core/app.ts", 'excludedPaths: ["/api"],',
      'excludedPaths: [\n      "/api",\n      // Atlas owns these routes when enabled; reserve them only while disabled.\n      ...(app.config.backoffice.enabled ? [] : [applicationBackoffice.basePath, "/_atlas_assets"]),\n    ],');
    replaceSource(this, "src/client/src/main.tsx", "      </nav>",
      `        {/* Atlas is enabled locally; resources belong to the application. */}
        <a className="resource" href="/admin">
          <div className="resource-heading">
            <h2>Atlas</h2>
            <span className="resource-arrow" aria-hidden="true">↗</span>
          </div>
          <p>Build your administration interface.<br />Start by adding your resources.</p>
          <span className="resource-caption">Open Atlas <span aria-hidden="true">→</span></span>
        </a>
      </nav>`);
    this.fs.append(this.destinationPath("README.md"), this.fs.read(`${templates}/README.md`));
  }
}
