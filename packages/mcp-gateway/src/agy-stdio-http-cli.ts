import { runAgyStdioHttpGatewayBridge } from "./agy-stdio-http-bridge.js";

const [endpoint, registrationId, tokenEnvironmentName, serviceIdsJson] = process.argv.slice(2);

if (!endpoint || !registrationId || !tokenEnvironmentName || !serviceIdsJson || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnvironmentName)) {
  process.stderr.write("Agy Gateway bridge configuration is invalid\n");
  process.exitCode = 2;
} else {
  try {
    const serviceIds: unknown = JSON.parse(serviceIdsJson);
    if (!Array.isArray(serviceIds) || serviceIds.some(id => typeof id !== "string")) throw new Error("invalid service ids");
    await runAgyStdioHttpGatewayBridge({ endpoint, registrationId, tokenEnvironmentName, serviceIds });
  } catch {
    process.stderr.write("Agy Gateway bridge stopped; Gateway outcome may be unknown\n");
    process.exitCode = 2;
  }
}
