import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * The one identity every signal (traces, metrics, logs) is tagged with, so a backend can join them and,
 * crucially, tell two instances apart: every instance runs `service.name=petty`, so two of them sending
 * to one place merge into nonsense without `deployment.environment` (PETTY-92). The value comes from
 * `DEPLOYMENT_ENV` (for example "home", "public").
 */
export const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

export function otelResource(version: string, deploymentEnv: string): Resource {
  const attrs: Record<string, string> = { [ATTR_SERVICE_NAME]: "petty", [ATTR_SERVICE_VERSION]: version };
  if (deploymentEnv) attrs[ATTR_DEPLOYMENT_ENVIRONMENT] = deploymentEnv;
  // PETTY-218: distinguish the machines or pods of one instance so their metric series don't collapse
  // into one. Fly.io sets FLY_MACHINE_ID; Docker and Kubernetes set HOSTNAME.
  const instanceId = process.env["FLY_MACHINE_ID"] ?? process.env["HOSTNAME"] ?? "";
  if (instanceId) attrs["service.instance.id"] = instanceId;
  return resourceFromAttributes(attrs);
}
