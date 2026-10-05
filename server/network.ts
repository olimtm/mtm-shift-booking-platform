import { EnvHttpProxyAgent, type Dispatcher } from 'undici';

let proxyDispatcher: Dispatcher | undefined;

/** Respect the cloud host's HTTPS proxy and NO_PROXY without weakening TLS verification. */
export function outboundDispatcher(): Dispatcher | undefined {
  if (
    !process.env.HTTPS_PROXY &&
    !process.env.https_proxy &&
    !process.env.HTTP_PROXY &&
    !process.env.http_proxy
  )
    return undefined;
  return (proxyDispatcher ??= new EnvHttpProxyAgent());
}
