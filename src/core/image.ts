/**
 * Which image produced this review, and which bytes that was.
 *
 * The workflow runs `:latest`, because pinning by digest means a one-line commit on every change and
 * this is a project still finding its shape. The cost of a moving tag is attribution — "goby found
 * this" no longer says which bytes did — so the publisher resolves the tag to a digest once, at the
 * start, and puts both in the review body. The finding stays reproducible after the tag moves.
 *
 * Resolution is a registry lookup, not a docker call: the tag we were given is the tag GitHub
 * started us with, and the manifest it points at is what we ask the registry for.
 */
export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

/** `ghcr.io/owner/name:tag` → its parts. Digests pass through as their own tag. */
export function parse_image(reference: string): ImageRef | null {
  const trimmed = reference.trim();
  // `name@sha256:…` carries its identity instead of a tag; keeping it in the same field means the
  // digest case needs no second code path.
  const [name, digest] = trimmed.split('@');
  const match = /^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9._/-]+?)(?::([A-Za-z0-9._-]+))?$/i.exec(name);
  if (!match) return null;
  return { registry: match[1], repository: match[2], tag: digest ?? match[3] ?? 'latest' };
}

/**
 * The digest a tag points at right now, or null.
 *
 * Anonymous pull is enough for a public package; when the package is private the caller's token is
 * used as basic credentials, which is the same exchange `docker login` performs. Any failure returns
 * null — an unresolved digest must not fail a review, it just means the body says "tag only".
 */
export async function resolve_digest(reference: string, token?: string | null): Promise<string | null> {
  const parsed = parse_image(reference);
  if (!parsed) return null;
  if (/^sha256:[0-9a-f]{64}$/.test(parsed.tag)) return parsed.tag;
  // Only GitHub's registry gets the job token. A custom image can name any host, and a token with
  // pull-requests: write must not be sent to one because somebody configured a different registry.
  const authorization = token && parsed.registry === 'ghcr.io'
    ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    : undefined;
  try {
    const tokenUrl = `https://${parsed.registry}/token?scope=repository:${parsed.repository}:pull&service=${parsed.registry}`;
    const tokenResponse = await fetch(tokenUrl, {
      headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) return null;
    const { token } = await tokenResponse.json() as { token?: string };
    if (!token) return null;
    const manifest = await fetch(`https://${parsed.registry}/v2/${parsed.repository}/manifests/${parsed.tag}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json',
      },
      signal: AbortSignal.timeout(5000),
    });
    const digest = manifest.headers.get('docker-content-digest');
    return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}
