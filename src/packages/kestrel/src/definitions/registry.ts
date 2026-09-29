/** Collects application definitions during composition in registration order. */
export class DefinitionRegistry<Definition> {
  private readonly registeredDefinitions: Definition[] = [];

  /** Registers one or several already validated definitions. */
  public register(...definitions: readonly Definition[]): this {
    this.registeredDefinitions.push(...definitions);

    return this;
  }

  /** Returns the immutable definition catalog consumed by runtimes and tools. */
  public get definitions(): readonly Definition[] {
    return this.registeredDefinitions;
  }
}
