import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * The one identity every signal (traces, metrics, logs) is tagged with, so Grafana can join them and,
 * crucially, tell two instances apart: home and the public cloud both run `service.name=petty`, so
 * without `deployment.environment` their metrics merge into nonsense (homelab, PETTY-92). The value
 * comes from `DEPLOYMENT_ENV` (home = "home", Fly = "public").
 */
export const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

export function otelResource(version: string, deploymentEnv: string): Resource {
  const attrs: Record<string, string> = { [ATTR_SERVICE_NAME]: "petty", [ATTR_SERVICE_VERSION]: version };
  if (deploymentEnv) attrs[ATTR_DEPLOYMENT_ENVIRONMENT] = deploymentEnv;
  return resourceFromAttributes(attrs);
}
