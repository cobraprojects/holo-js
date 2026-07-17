export interface RuntimeLifecycleContext {
  readonly projectRoot: string
}

export interface RuntimeContribution<TContext extends RuntimeLifecycleContext = RuntimeLifecycleContext> {
  readonly name: string
  readonly dependsOn?: readonly string[]
  initialize(context: TContext): void | Promise<void>
  dispose?(context: TContext): void | Promise<void>
}

function orderContributions<TContext extends RuntimeLifecycleContext>(
  contributions: readonly RuntimeContribution<TContext>[],
): readonly RuntimeContribution<TContext>[] {
  const byName = new Map(contributions.map(contribution => [contribution.name, contribution]))
  if (byName.size !== contributions.length) {
    throw new Error('[Holo Runtime] Runtime contribution names must be unique.')
  }

  const ordered: RuntimeContribution<TContext>[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (contribution: RuntimeContribution<TContext>): void => {
    if (visited.has(contribution.name)) return
    if (visiting.has(contribution.name)) {
      throw new Error(`[Holo Runtime] Circular runtime dependency at "${contribution.name}".`)
    }

    visiting.add(contribution.name)
    for (const dependencyName of contribution.dependsOn ?? []) {
      const dependency = byName.get(dependencyName)
      if (!dependency) {
        throw new Error(`[Holo Runtime] Contribution "${contribution.name}" requires missing contribution "${dependencyName}".`)
      }
      visit(dependency)
    }
    visiting.delete(contribution.name)
    visited.add(contribution.name)
    ordered.push(contribution)
  }

  contributions.forEach(visit)
  return Object.freeze(ordered)
}

export class RuntimeLifecycle<TContext extends RuntimeLifecycleContext = RuntimeLifecycleContext> {
  private readonly ordered: readonly RuntimeContribution<TContext>[]
  private initialized: RuntimeContribution<TContext>[] = []

  constructor(contributions: readonly RuntimeContribution<TContext>[]) {
    this.ordered = orderContributions(contributions)
  }

  async initialize(context: TContext): Promise<void> {
    if (this.initialized.length > 0) {
      throw new Error('[Holo Runtime] Runtime lifecycle is already initialized.')
    }

    try {
      for (const contribution of this.ordered) {
        this.initialized.push(contribution)
        await contribution.initialize(context)
      }
    } catch (error) {
      try {
        await this.dispose(context)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '[Holo Runtime] Initialization and rollback both failed.')
      }
      throw error
    }
  }

  async dispose(context: TContext): Promise<void> {
    const initialized = this.initialized
    this.initialized = []
    const failures: unknown[] = []
    for (const contribution of initialized.reverse()) {
      try {
        await contribution.dispose?.(context)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, '[Holo Runtime] Multiple runtime contributions failed to dispose.')
    }
  }
}

export function createRuntimeLifecycle<TContext extends RuntimeLifecycleContext>(
  contributions: readonly RuntimeContribution<TContext>[],
): RuntimeLifecycle<TContext> {
  return new RuntimeLifecycle(contributions)
}
