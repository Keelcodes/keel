import { MigrationError } from './errors.js';

/** A module generation. Mirrors the `module_version` column in the session store. */
export type ModuleVersion = string;

/** How a session's `validateUserOp` payload is signed. */
export type ValidationEncoding = 'onchain' | 'payload';

/** What the router needs to know about one module generation. */
export interface ModuleDescriptor {
  version: ModuleVersion;
  /** Deployed module address, when known. */
  address?: string;
  encoding: ValidationEncoding;
  /** Whether this generation allows more than one session per account. */
  multiSession: boolean;
  /** Whether spend limits are enforced on-chain, not off-chain only. */
  enforcedLimits: boolean;
}

export interface ModuleRegistry {
  readonly defaultVersion: ModuleVersion;
  get(version: ModuleVersion): ModuleDescriptor | undefined;
  list(): readonly ModuleDescriptor[];
  /** The generation new sessions are written to. */
  default(): ModuleDescriptor;
}

export interface CreateModuleRegistryOptions {
  /**
   * Generation new (version-less) sessions route to. Defaults to the last
   * descriptor added, so callers can list generations oldest-first and let the
   * newest win.
   */
  defaultVersion?: ModuleVersion;
}

/** Builds a registry from module descriptors, oldest generation first. */
export function createModuleRegistry(
  descriptors: readonly ModuleDescriptor[],
  options: CreateModuleRegistryOptions = {},
): ModuleRegistry {
  if (descriptors.length === 0) {
    throw new MigrationError('no-default-version', 'a module registry needs at least one descriptor');
  }

  const byVersion = new Map<ModuleVersion, ModuleDescriptor>();
  for (const descriptor of descriptors) {
    if (byVersion.has(descriptor.version)) {
      throw new MigrationError('duplicate-module-version', `module version ${descriptor.version} registered twice`);
    }
    byVersion.set(descriptor.version, descriptor);
  }

  const defaultVersion = options.defaultVersion ?? descriptors[descriptors.length - 1]!.version;
  const defaultDescriptor = byVersion.get(defaultVersion);
  if (defaultDescriptor === undefined) {
    throw new MigrationError('no-default-version', `default version ${defaultVersion} is not registered`);
  }

  return {
    defaultVersion,
    get: (version) => byVersion.get(version),
    list: () => [...byVersion.values()],
    default: () => defaultDescriptor,
  };
}

/** A session record as stored by the relay; the version column may be absent. */
export interface SessionRecord {
  id: string;
  /** Absent on records written before the version column existed. */
  moduleVersion?: ModuleVersion;
}

/**
 * Routes a session to its module generation.
 *
 * A version-less record (pre-backfill) routes to the default generation — the
 * "lazy" half of lazy migration: legacy sessions are never rewritten, they just
 * keep working until they expire or are revoked.
 */
export function routeSession(registry: ModuleRegistry, session: SessionRecord): ModuleDescriptor {
  if (session.moduleVersion === undefined) return registry.default();

  const descriptor = registry.get(session.moduleVersion);
  if (descriptor === undefined) {
    throw new MigrationError(
      'unknown-module-version',
      `session ${session.id} references unregistered module version ${session.moduleVersion}`,
    );
  }
  return descriptor;
}
