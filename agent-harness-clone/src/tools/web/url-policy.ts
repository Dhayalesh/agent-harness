import { AgentHarnessError } from '../../core/errors.js';

/** Upper bound on accepted URL length, to limit exfiltration surface. */
export const MAX_FETCH_URL_LENGTH = 2_000;

export type UrlPolicyOptions = {
  /** When set, only these hosts may be fetched (suffix match on host). */
  allowedHosts?: readonly string[];
  /** Hosts that may never be fetched (suffix match on host). */
  blockedHosts?: readonly string[];
  /** Allow plain http instead of upgrading to https. Off by default. */
  allowInsecureHttp?: boolean;
  /**
   * Permit loopback, link-local, and private-range targets. Off by default
   * because a model-controlled URL reaching internal services is an SSRF risk.
   */
  allowPrivateHosts?: boolean;
};

/**
 * Validate a model-supplied URL and return the URL that should be requested.
 * `http` is upgraded to `https` unless explicitly allowed.
 *
 * @throws AgentHarnessError with a stable code for every rejection reason
 */
export function resolveFetchUrl(value: string, options: UrlPolicyOptions = {}): URL {
  if (value.length > MAX_FETCH_URL_LENGTH) {
    throw new AgentHarnessError(
      `URL exceeds the ${MAX_FETCH_URL_LENGTH} character limit`,
      'URL_TOO_LONG',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentHarnessError(`URL could not be parsed: ${value}`, 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentHarnessError(
      `Only http and https URLs can be fetched, received ${url.protocol}`,
      'UNSUPPORTED_URL_SCHEME',
    );
  }
  if (url.username || url.password) {
    throw new AgentHarnessError('URL must not embed credentials', 'URL_WITH_CREDENTIALS');
  }
  if (url.protocol === 'http:' && !options.allowInsecureHttp) {
    url.protocol = 'https:';
  }
  assertHostAllowed(url.hostname, options);
  return url;
}

/** Reject hosts that are non-public or explicitly blocked by the operator. */
export function assertHostAllowed(hostname: string, options: UrlPolicyOptions = {}): void {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new AgentHarnessError('URL has no host', 'INVALID_URL');

  if (!options.allowPrivateHosts && isNonPublicHost(host)) {
    throw new AgentHarnessError(
      `Refusing to fetch a non-public host: ${host}`,
      'PRIVATE_HOST_BLOCKED',
    );
  }
  if (matchesHost(host, options.blockedHosts)) {
    throw new AgentHarnessError(`Host is blocked by policy: ${host}`, 'HOST_BLOCKED');
  }
  if (
    options.allowedHosts &&
    options.allowedHosts.length > 0 &&
    !matchesHost(host, options.allowedHosts)
  ) {
    throw new AgentHarnessError(`Host is not in the allowlist: ${host}`, 'HOST_NOT_ALLOWED');
  }
}

/**
 * True for loopback, link-local, private, and non-routable names. IP literals
 * are treated as non-public outright: a model has no legitimate reason to
 * address one, and allowing them defeats hostname-based policy.
 */
export function isNonPublicHost(host: string): boolean {
  const bracketless = host.replace(/^\[|\]$/g, '');
  if (bracketless.includes(':')) return true; // IPv6 literal
  if (/^\d+(?:\.\d+){0,3}$/.test(bracketless)) return true; // IPv4 literal or shorthand
  if (!bracketless.includes('.')) return true; // bare name such as localhost or an intranet host
  return /\.(?:local|localhost|internal|intranet|corp|home|lan|test|example|invalid|onion)$/.test(
    bracketless,
  );
}

/**
 * Redirects are followed only within the same site. A cross-site redirect is
 * surfaced to the model instead, so an open redirect on a trusted domain cannot
 * silently pull content from somewhere the user never approved.
 */
export function isSameSiteRedirect(from: URL, to: URL): boolean {
  if (from.protocol !== to.protocol) return false;
  if (from.port !== to.port) return false;
  if (to.username || to.password) return false;
  return stripWww(from.hostname) === stripWww(to.hostname);
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function matchesHost(host: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns) return false;
  return patterns.some((pattern) => {
    const candidate = pattern
      .toLowerCase()
      .replace(/^\*?\./, '')
      .replace(/\.$/, '');
    if (!candidate) return false;
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}
